import { describe, expect, test } from "bun:test";
import type { OAuthTokens } from "@earendil-works/pi-mcp/oauth";
import {
  clearTransientOAuthState,
  type McpOAuthStore,
  makeMcpOAuthProvider,
  makeMcpOAuthStateStore,
  parseOAuthBlob,
  persistClientInformation,
} from "../../src/mcp/oauth.ts";

/** In-memory fake port — one payload string per URL, like the real store row. */
function fakeStore(): McpOAuthStore & { dump(): Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    load: (url) => rows.get(url),
    save: (url, payload) => {
      rows.set(url, payload);
    },
    clear: (url) => {
      rows.delete(url);
    },
    dump: () => rows,
  };
}

const URL_A = "https://mcp.example.com/sse";

function tokens(): OAuthTokens {
  return { access_token: "at-123", token_type: "Bearer", refresh_token: "rt-456", expires_in: 3600 };
}

function provider(store: McpOAuthStore, client?: { clientId: string; clientSecret?: string }) {
  return makeMcpOAuthProvider({
    url: URL_A,
    store,
    redirectUrl: "http://localhost:8888/callback",
    onRedirect: () => {},
    ...(client ? { client } : {}),
  });
}

describe("makeMcpOAuthProvider", () => {
  test("saveTokens round-trips and persists across a fresh provider instance", async () => {
    const store = fakeStore();
    const p = provider(store);

    expect(await p.tokens()).toBeUndefined();
    await p.saveTokens(tokens());
    expect(await p.tokens()).toEqual(tokens());

    // A new provider sharing the same store reads the persisted tokens.
    const reborn = provider(store);
    expect(await reborn.tokens()).toEqual(tokens());
  });

  test("saveClientInformation round-trips through the payload", async () => {
    const store = fakeStore();
    const p = provider(store);

    expect(await p.clientInformation()).toBeUndefined();
    await p.saveClientInformation({ client_id: "dcr-client", client_secret: "dcr-secret" });
    expect(await p.clientInformation()).toEqual({ client_id: "dcr-client", client_secret: "dcr-secret" });
  });

  test("preset confidential client is returned and drives client_secret_post", async () => {
    const store = fakeStore();
    const p = provider(store, { clientId: "preset-id", clientSecret: "preset-secret" });

    expect(await p.clientInformation()).toEqual({ client_id: "preset-id", client_secret: "preset-secret" });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  test("preset public client (no secret) uses token_endpoint_auth_method none", async () => {
    const store = fakeStore();
    const p = provider(store, { clientId: "public-id" });

    expect(await p.clientInformation()).toEqual({ client_id: "public-id" });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  test("saveCodeVerifier persists; codeVerifier() throws when none saved; survives a fresh instance", async () => {
    const store = fakeStore();
    const p = provider(store);

    expect(p.codeVerifier()).rejects.toThrow();
    await p.saveCodeVerifier("pkce-verifier-xyz");
    expect(await p.codeVerifier()).toBe("pkce-verifier-xyz");

    const reborn = provider(store);
    expect(await reborn.codeVerifier()).toBe("pkce-verifier-xyz");
  });

  test("redirectToAuthorization invokes onRedirect with the URL", async () => {
    const store = fakeStore();
    let seen: URL | undefined;
    const p = makeMcpOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: (authorizationUrl) => {
        seen = authorizationUrl;
      },
    });

    const authUrl = new URL("https://auth.example.com/authorize?client_id=x");
    await p.redirectToAuthorization(authUrl);
    expect(seen).toBe(authUrl);
  });

  test("a throwing onRedirect (daemon mode) propagates", async () => {
    const store = fakeStore();
    const p = makeMcpOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {
        throw new Error("interactive auth required");
      },
    });

    expect(p.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).rejects.toThrow(
      /interactive auth required/,
    );
  });

  test("clientMetadata carries the expected redirect_uris and grant/response types", () => {
    const store = fakeStore();
    const p = provider(store);

    const meta = p.clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://localhost:8888/callback"]);
    expect(meta.client_name).toBe("fragua");
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(p.redirectUrl).toBe("http://localhost:8888/callback");
  });

  test("state() generates the CSRF value and persists it into the blob as oauthState", async () => {
    const store = fakeStore();
    const p = provider(store);
    const s = await p.state();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
    // The persisted blob carries it back so the login callback's CSRF check can read it.
    expect(parseOAuthBlob(store.dump().get(URL_A))?.oauthState).toBe(s);
    // Idempotent within a flow — the same instance returns the first value.
    expect(await p.state()).toBe(s);
  });

  test("corrupt payload folds to empty (tolerated)", async () => {
    const store = fakeStore();
    store.save(URL_A, "{not valid json");
    const p = provider(store);

    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
    await p.saveTokens(tokens());
    expect(await p.tokens()).toEqual(tokens());
  });
});

describe("makeMcpOAuthStateStore", () => {
  test("backfills serverUrl from the key for a legacy (pre-pi-mcp) blob", async () => {
    const store = fakeStore();
    store.save(URL_A, JSON.stringify({ tokens: { access_token: "x", token_type: "Bearer" } }));
    const loaded = await makeMcpOAuthStateStore(store, URL_A).load();
    expect(loaded?.serverUrl).toBe(URL_A); // filled from the key, not the (missing) field
    expect(loaded?.tokens?.access_token).toBe("x");
  });

  test("preserves a serverUrl already present in a new-shape blob", async () => {
    const store = fakeStore();
    store.save(URL_A, JSON.stringify({ serverUrl: URL_A, tokens: { access_token: "y", token_type: "Bearer" } }));
    expect((await makeMcpOAuthStateStore(store, URL_A).load())?.serverUrl).toBe(URL_A);
  });
});

describe("clearTransientOAuthState", () => {
  test("drops oauthState + codeVerifier, keeps tokens and client registration", async () => {
    const store = fakeStore();
    const p = provider(store);
    await p.saveTokens(tokens());
    await p.saveClientInformation({ client_id: "dcr-client" });
    await p.saveCodeVerifier("pkce-verifier-xyz");
    const firstState = await p.state();
    clearTransientOAuthState(store, URL_A);
    const blob = parseOAuthBlob(store.dump().get(URL_A));
    expect(blob?.oauthState).toBeUndefined();
    expect(blob?.codeVerifier).toBeUndefined();
    expect(blob?.tokens).toEqual(tokens());
    expect(blob?.clientInformation).toEqual({ client_id: "dcr-client" });
    expect(blob?.serverUrl).toBe(URL_A);
    // pi-mcp's state() reuses a stored value; once cleared, the next login gets a fresh one.
    expect(await provider(store).state()).not.toBe(firstState);
  });

  test("no row / no transient fields → no write", () => {
    const store = fakeStore();
    clearTransientOAuthState(store, URL_A);
    expect(store.dump().has(URL_A)).toBe(false);
    const settled = JSON.stringify({ serverUrl: URL_A, tokens: tokens() });
    store.save(URL_A, settled);
    clearTransientOAuthState(store, URL_A);
    expect(store.dump().get(URL_A)).toBe(settled);
  });
});

describe("persistClientInformation", () => {
  test("writes a preset confidential client through the port so the daemon can read it", () => {
    const store = fakeStore();
    persistClientInformation(store, URL_A, { client_id: "conf-id", client_secret: "conf-secret" });
    const blob = parseOAuthBlob(store.dump().get(URL_A));
    expect(blob?.clientInformation).toEqual({ client_id: "conf-id", client_secret: "conf-secret" });
    expect(blob?.serverUrl).toBe(URL_A);
  });
});

describe("parseOAuthBlob", () => {
  test("decodes a valid blob; folds absent/corrupt to undefined", () => {
    expect(parseOAuthBlob(JSON.stringify({ tokens: { access_token: "x" } }))?.tokens?.access_token).toBe("x");
    expect(parseOAuthBlob(undefined)).toBeUndefined();
    expect(parseOAuthBlob("not json{")).toBeUndefined();
    expect(parseOAuthBlob(JSON.stringify(["array"]))).toBeUndefined();
  });

  test("an old-shape blob (no serverUrl) still reports its tokens — login carries over without re-login", () => {
    const old = JSON.stringify({ tokens: { access_token: "legacy-at" }, clientInformation: { client_id: "c" } });
    expect(parseOAuthBlob(old)?.tokens?.access_token).toBe("legacy-at");
    expect(parseOAuthBlob(old)?.serverUrl).toBeUndefined();
  });

  test("a new McpOAuthState blob with serverUrl parses", () => {
    const fresh = JSON.stringify({ serverUrl: URL_A, tokens: { access_token: "new-at", token_type: "Bearer" } });
    expect(parseOAuthBlob(fresh)?.tokens?.access_token).toBe("new-at");
    expect(parseOAuthBlob(fresh)?.serverUrl).toBe(URL_A);
  });
});
