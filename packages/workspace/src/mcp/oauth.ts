// Store-backed OAuth 2.1 client provider for remote (HTTP) MCP servers.
//
// The MCP SDK drives the whole OAuth dance through an `OAuthClientProvider`
// object handed to the streamable-HTTP transport: it asks us for client
// metadata, reads/writes tokens, persists a PKCE verifier across the browser
// redirect, and calls `redirectToAuthorization` to begin interactive auth.
//
// All provider state for one server URL is persisted as a SINGLE opaque JSON
// blob through the `McpOAuthStore` port. That port is the ONLY seam to durable
// storage, which keeps @fragua/workspace free of any @fragua/store dependency —
// the real store-backed implementation is injected by callers (CLI login flow,
// daemon connector) in a later slice.

import { randomUUID } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

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
 * and the (later) `fragua mcp login` command MUST present the same fixed value
 * — hence a shared constant, not a per-run ephemeral port. */
export const MCP_OAUTH_CALLBACK_URL = "http://127.0.0.1:41765/callback";

/** A preset confidential client (client_id + optional secret), skipping DCR. */
export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
}

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

/** The full shape persisted in the port payload for one server URL. The single
 * authority for the blob layout — every reader (this provider, the CLI's
 * `hasStoredTokens`, the export scrubber's literal extraction) must fold to it. */
export interface PersistedOAuthState {
  clientInformation?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

/** Parse a stored OAuth payload string into `PersistedOAuthState`. Returns
 * `undefined` for an absent or corrupt blob (never throws) — the one place the
 * blob's JSON shape is decoded, so callers don't re-hand-roll `JSON.parse`. */
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

export class StoredOAuthProvider implements OAuthClientProvider {
  private readonly url: string;
  private readonly store: McpOAuthStore;
  private readonly _redirectUrl: string;
  private readonly onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  private readonly client: McpOAuthClient | undefined;
  // Per-instance cache of the parsed blob. One provider instance owns its own
  // writes, so a handshake's repeated reads/writes need not re-parse the store
  // each time. Distinct instances (login vs daemon) don't share it — correct,
  // they operate independently.
  private cache: PersistedOAuthState | undefined;
  // The CSRF `state` is per-login and per-instance — it only has to survive the
  // in-process browser round-trip (same provider instance handles both the
  // authorize-URL build and the callback). Kept in memory, NOT in the shared
  // store row, so a concurrent `mcp check`/second login for the same server can't
  // clobber it (and read-only `check` never mutates the persisted row).
  private pendingState: string | undefined;

  constructor(opts: StoredOAuthProviderOptions) {
    this.url = opts.url;
    this.store = opts.store;
    this._redirectUrl = opts.redirectUrl;
    this.onRedirect = opts.onRedirect;
    this.client = opts.client;
  }

  // Read the whole blob lazily; an absent or corrupt payload folds to empty so
  // a garbled row can't wedge the flow — the SDK will re-drive auth from clean.
  private read(): PersistedOAuthState {
    if (this.cache !== undefined) return this.cache;
    const state = this.readFromStore();
    this.cache = state;
    return state;
  }

  private readFromStore(): PersistedOAuthState {
    return parseOAuthBlob(this.store.load(this.url)) ?? {};
  }

  // Write-through: fold the mutation into the LATEST persisted blob (re-read from
  // the store, NOT the per-instance cache) and persist the whole thing. Distinct
  // provider instances (daemon connector vs CLI login, or two concurrent steps)
  // each hold their own cache; merging into a stale cache would let a later write
  // clobber tokens another instance just persisted. `load`→merge→`save` runs with
  // no await between, so on the single-threaded loop it's effectively atomic.
  private write(patch: { [K in keyof PersistedOAuthState]?: PersistedOAuthState[K] | undefined }): void {
    // Explicit `undefined` in the patch DELETES a key — used to clear the
    // single-use PKCE verifier on token save. Prune undefined entries so the
    // merged blob is a clean `PersistedOAuthState` (exactOptionalPropertyTypes).
    const merged = { ...this.readFromStore(), ...patch } as Record<string, unknown>;
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    const next = merged as PersistedOAuthState;
    this.cache = next;
    this.store.save(this.url, JSON.stringify(next));
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const hasSecret = this.client?.clientSecret !== undefined;
    return {
      redirect_uris: [this._redirectUrl],
      client_name: "fragua",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: hasSecret ? "client_secret_post" : "none",
    };
  }

  // Called by the SDK before it builds the authorization URL; the value is
  // echoed back on the callback. Generated fresh + persisted so it survives the
  // redirect, and validated against `expectedAuthState()` by the login callback.
  state(): string {
    // Idempotent within a flow: the SDK may call `state()` more than once, but the
    // browser echoes back the FIRST value — regenerating would make
    // `expectedAuthState()` reject the valid callback as a state mismatch.
    if (this.pendingState !== undefined) return this.pendingState;
    this.pendingState = randomUUID();
    return this.pendingState;
  }

  /** The CSRF `state` expected on the authorization callback, if a flow is in
   * progress. The interactive login server compares the returned `state`
   * against this before accepting the code. */
  expectedAuthState(): string | undefined {
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformation | undefined {
    if (this.client !== undefined) {
      const info: OAuthClientInformation = { client_id: this.client.clientId };
      if (this.client.clientSecret !== undefined) info.client_secret = this.client.clientSecret;
      return info;
    }
    return this.read().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformation): void {
    this.write({ clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // Clear the single-use PKCE verifier on success — it has served its purpose
    // and shouldn't linger in the persisted blob (or any export of it).
    this.write({ tokens, codeVerifier: undefined });
  }

  redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
    return this.onRedirect(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.read().codeVerifier;
    if (verifier === undefined) {
      throw new Error(`no PKCE code verifier stored for MCP server ${this.url}`);
    }
    return verifier;
  }
}

/** A headless provider for non-interactive contexts (the daemon connector, and
 * `mcp check`): it reads stored tokens and refreshes silently, but a flow that
 * would need a browser throws instead of opening one. Single source of the
 * "not logged in" message so the daemon and CLI can't drift. */
export function makeHeadlessMcpProvider(url: string, store: McpOAuthStore): StoredOAuthProvider {
  return new StoredOAuthProvider({
    url,
    store,
    redirectUrl: MCP_OAUTH_CALLBACK_URL,
    onRedirect: () => {
      throw new Error(`not logged in — run \`fragua mcp login\` for ${url}`);
    },
  });
}
