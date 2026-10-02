// Store-backed OAuth 2.1 credentials for remote (HTTP) MCP servers.
//
// pi-mcp's `McpOAuthProvider` (@earendil-works/pi-mcp/oauth) drives the whole
// OAuth dance — discovery, dynamic client registration, PKCE, the browser
// redirect, token refresh. fragua supplies two things: an `McpOAuthStateStore`
// that persists the provider's state through our `McpOAuthStore` port, and the
// `clientMetadata` (client_name "fragua", the grant/response types, the
// confidential-vs-public auth method).
//
// All provider state for one server URL is persisted as a SINGLE opaque JSON
// blob through the `McpOAuthStore` port. That port is the ONLY seam to durable
// storage, which keeps @fragua/workspace free of any @fragua/store dependency —
// the real store-backed implementation is injected by callers (CLI login flow,
// daemon connector).

import {
  McpOAuthProvider,
  type McpOAuthProviderOptions,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthClientInformation,
} from "@earendil-works/pi-mcp/oauth";

/**
 * Persistence port for a single MCP server's OAuth state. Keyed by the server
 * URL; the payload is one opaque JSON string the provider owns end-to-end. The
 * real implementation is backed by the store's `mcp_oauth` methods and supplied
 * by callers — this module depends ONLY on this interface.
 */
export interface McpOAuthStore {
  /** The opaque JSON payload for this server URL, or `undefined` if none. */
  load(url: string): string | undefined;
  save(url: string, payload: string): void;
  clear(url: string): void;
}

/** The fixed OAuth redirect URI fragua registers with confidential clients. A
 * confidential app pre-registers its redirect URI, so both the daemon provider
 * and the `fragua mcp login` command MUST present the same fixed value — hence a
 * shared constant, not a per-run ephemeral port. */
export const MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:41765/callback";

/** A preset confidential client (client_id + optional secret), skipping DCR. */
export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * The full shape persisted in the port payload for one server URL. It is
 * pi-mcp's `McpOAuthState` — with `serverUrl` optional, because legacy rows
 * (written before the pi-mcp swap) hold `{ clientInformation?, tokens?,
 * codeVerifier? }` and lack it; the state-store adapter fills it from the key.
 * The single authority for the blob layout — every reader (the state-store
 * adapter, the CLI's `hasStoredTokens`, @fragua/store's export scrubber) must
 * fold to it.
 */
export interface PersistedOAuthState extends Omit<McpOAuthState, "serverUrl"> {
  serverUrl?: string;
}

/** Parse a stored OAuth payload string into `PersistedOAuthState`. Returns
 * `undefined` for an absent or corrupt blob (never throws) — the one place the
 * blob's JSON shape is decoded, so callers don't re-hand-roll `JSON.parse`.
 * Tolerates BOTH the legacy shape (no `serverUrl`) and the new `McpOAuthState`
 * shape; `tokens` / `clientInformation` / `codeVerifier` carry the same field
 * names in both, so a login made before the pi-mcp swap still reports its
 * tokens and still scrubs. */
export function parseOAuthBlob(raw: string | undefined): PersistedOAuthState | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as PersistedOAuthState;
  } catch {
    /* corrupt → undefined */
  }
  return undefined;
}

/** Adapt fragua's URL-keyed `McpOAuthStore` port to pi-mcp's single-URL
 * `McpOAuthStateStore`. A legacy blob missing `serverUrl` is backfilled from the
 * key so pi-mcp's per-server isolation guard (which ignores state for a
 * different URL) still accepts it. */
export function makeMcpOAuthStateStore(store: McpOAuthStore, url: string): McpOAuthStateStore {
  return {
    load: (): McpOAuthState | undefined => {
      const parsed = parseOAuthBlob(store.load(url));
      if (parsed === undefined) return undefined;
      return parsed.serverUrl !== undefined ? (parsed as McpOAuthState) : { ...parsed, serverUrl: url };
    },
    save: (state: McpOAuthState): void => {
      store.save(url, JSON.stringify(state));
    },
  };
}

/** Options for building fragua's MCP OAuth provider. */
export interface StoredOAuthProviderOptions {
  /** The MCP server URL — the `McpOAuthStore` key. */
  url: string;
  store: McpOAuthStore;
  /** The login callback URL (e.g. `http://localhost:PORT/callback`). */
  redirectUrl: string;
  /** How to begin interactive auth. The daemon passes one that throws (a run
   * never blocks on a browser); the CLI passes one that opens the URL. */
  onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  /** Preset confidential client — when provided, skips dynamic registration. */
  client?: McpOAuthClient;
}

/** The client metadata fragua registers for every MCP OAuth flow. A confidential
 * client (preset secret) authenticates at the token endpoint with
 * `client_secret_post`; a public / DCR client uses `none` (PKCE only). */
function fraguaClientMetadata(hasSecret: boolean): McpOAuthProviderOptions["clientMetadata"] {
  return {
    client_name: "fragua",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: hasSecret ? "client_secret_post" : "none",
  };
}

/** Build a store-backed `McpOAuthProvider` for one MCP server URL. pi-mcp owns
 * discovery / DCR / PKCE / refresh / the redirect; fragua supplies persistence
 * (via the `McpOAuthStore` port) and the client metadata. */
export function makeMcpOAuthProvider(opts: StoredOAuthProviderOptions): McpOAuthProvider {
  const providerOpts: McpOAuthProviderOptions = {
    serverUrl: opts.url,
    redirectUrl: opts.redirectUrl,
    clientMetadata: fraguaClientMetadata(opts.client?.clientSecret !== undefined),
    store: makeMcpOAuthStateStore(opts.store, opts.url),
    onRedirect: opts.onRedirect,
  };
  if (opts.client !== undefined) {
    providerOpts.clientId = opts.client.clientId;
    if (opts.client.clientSecret !== undefined) providerOpts.clientSecret = opts.client.clientSecret;
  }
  return new McpOAuthProvider(providerOpts);
}

/** Merge client-registration info into the persisted blob for one URL. The
 * login flow uses it to persist a PRESET confidential client (client_id +
 * secret) so the daemon's headless provider — built WITHOUT those flags — can
 * read them to refresh tokens. `McpOAuthProvider.saveClientInformation` is a
 * no-op when a client is preset, so we write through the port directly, keeping
 * the blob-shape authority in this module. */
export function persistClientInformation(store: McpOAuthStore, url: string, info: OAuthClientInformation): void {
  const current = parseOAuthBlob(store.load(url)) ?? {};
  const next: McpOAuthState = { ...current, serverUrl: current.serverUrl ?? url, clientInformation: info };
  store.save(url, JSON.stringify(next));
}

/** Drop the per-login transients — the CSRF `oauthState` and the single-use
 * PKCE `codeVerifier` — from the persisted blob, keeping tokens and client
 * registration. pi-mcp's `McpOAuthProvider` never clears either after a
 * successful exchange, and `state()` REUSES a stored `oauthState`, so without
 * this every later login for the same URL would present the same CSRF value and
 * the verifier would linger in the row (and any export of it). The login flow
 * calls it before it starts (a stale value from an interrupted login must not be
 * reused) and after it succeeds. A row without either field is left untouched. */
export function clearTransientOAuthState(store: McpOAuthStore, url: string): void {
  const current = parseOAuthBlob(store.load(url));
  if (current === undefined) return;
  if (current.oauthState === undefined && current.codeVerifier === undefined) return;
  const { oauthState: _state, codeVerifier: _verifier, ...rest } = current;
  store.save(url, JSON.stringify({ ...rest, serverUrl: rest.serverUrl ?? url }));
}

/** A headless provider for non-interactive contexts (the daemon connector, and
 * `mcp check`): it reads stored tokens and refreshes silently, but a flow that
 * would need a browser throws instead of opening one. Single source of the
 * "not logged in" message so the daemon and CLI can't drift. */
export function makeHeadlessMcpProvider(url: string, store: McpOAuthStore): McpOAuthProvider {
  return makeMcpOAuthProvider({
    url,
    store,
    redirectUrl: MCP_OAUTH_CALLBACK_URL,
    onRedirect: () => {
      throw new Error(`not logged in — run \`fragua mcp login\` for ${url}`);
    },
  });
}
