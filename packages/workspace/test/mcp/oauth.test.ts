import { describe, expect, test } from "bun:test";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { type McpOAuthStore, StoredOAuthProvider } from "../../src/mcp/oauth.ts";

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

describe("StoredOAuthProvider", () => {
  test("saveTokens clears the single-use PKCE verifier from the persisted blob", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });
    provider.saveCodeVerifier("verifier-abc");
    expect(provider.codeVerifier()).toBe("verifier-abc");
    provider.saveTokens(tokens());
    // Verifier gone from the persisted row; tokens remain.
    expect(JSON.parse(store.dump().get(URL_A) ?? "{}").codeVerifier).toBeUndefined();
    expect(provider.tokens()).toEqual(tokens());
  });

  test("saveTokens round-trips and persists across a fresh provider instance", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });

    expect(provider.tokens()).toBeUndefined();
    provider.saveTokens(tokens());
    expect(provider.tokens()).toEqual(tokens());

    // A new provider sharing the same store reads the persisted tokens.
    const reborn = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });
    expect(reborn.tokens()).toEqual(tokens());
  });

  test("saveClientInformation round-trips through the payload", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });

    expect(provider.clientInformation()).toBeUndefined();
    provider.saveClientInformation({ client_id: "dcr-client", client_secret: "dcr-secret" });
    expect(provider.clientInformation()).toEqual({ client_id: "dcr-client", client_secret: "dcr-secret" });
  });

  test("preset confidential client is returned and drives client_secret_post", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
      client: { clientId: "preset-id", clientSecret: "preset-secret" },
    });

    expect(provider.clientInformation()).toEqual({ client_id: "preset-id", client_secret: "preset-secret" });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  test("preset public client (no secret) uses token_endpoint_auth_method none", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
      client: { clientId: "public-id" },
    });

    expect(provider.clientInformation()).toEqual({ client_id: "public-id" });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  test("saveCodeVerifier persists; codeVerifier() throws when none saved", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });

    expect(() => provider.codeVerifier()).toThrow(/no PKCE code verifier/);
    provider.saveCodeVerifier("pkce-verifier-xyz");
    expect(provider.codeVerifier()).toBe("pkce-verifier-xyz");

    // Survives across a fresh instance (must persist across the redirect).
    const reborn = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });
    expect(reborn.codeVerifier()).toBe("pkce-verifier-xyz");
  });

  test("redirectToAuthorization invokes onRedirect with the URL", async () => {
    const store = fakeStore();
    let seen: URL | undefined;
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: (authorizationUrl) => {
        seen = authorizationUrl;
      },
    });

    const authUrl = new URL("https://auth.example.com/authorize?client_id=x");
    await provider.redirectToAuthorization(authUrl);
    expect(seen).toBe(authUrl);
  });

  test("a throwing onRedirect (daemon mode) propagates", async () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {
        throw new Error("interactive auth required");
      },
    });

    expect(() => provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).toThrow(
      /interactive auth required/,
    );
  });

  test("clientMetadata carries the expected redirect_uris and grant/response types", () => {
    const store = fakeStore();
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });

    const meta = provider.clientMetadata;
    expect(meta.redirect_uris).toEqual(["http://localhost:8888/callback"]);
    expect(meta.client_name).toBe("fragua");
    expect(meta.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.response_types).toEqual(["code"]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(provider.redirectUrl).toBe("http://localhost:8888/callback");
  });

  test("corrupt payload folds to empty (tolerated)", () => {
    const store = fakeStore();
    store.save(URL_A, "{not valid json");
    const provider = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });

    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toBeUndefined();
    // A mutation after a corrupt read writes a clean object.
    provider.saveTokens(tokens());
    expect(provider.tokens()).toEqual(tokens());
  });

  test("state() is per-instance in memory — never persisted, so a concurrent instance can't clobber it", () => {
    const store = fakeStore();
    const p1 = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });
    const s = p1.state();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
    // The SAME instance (which handles both the authorize build and the in-process
    // callback) reads it back.
    expect(p1.expectedAuthState()).toBe(s);
    // A DISTINCT instance (a concurrent `mcp check` / second login) does NOT share
    // it and — crucially — did not overwrite p1's state in the store.
    const p2 = new StoredOAuthProvider({
      url: URL_A,
      store,
      redirectUrl: "http://localhost:8888/callback",
      onRedirect: () => {},
    });
    expect(p2.expectedAuthState()).toBeUndefined();
    p2.state();
    expect(p1.expectedAuthState()).toBe(s); // p2's state didn't touch p1
    // And nothing CSRF-related was written to the shared store row.
    expect(store.load(URL_A)).toBeUndefined();
  });
});
