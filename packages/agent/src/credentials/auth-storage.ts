// Credential storage for API keys and OAuth tokens. Persists into the
// global fragua store (`provider_credentials` table).
//
// Resolution order:
//   1. provider_credentials row, kind=api_key → return the stored key verbatim.
//      No !cmd / env-var resolution: keys are short literal strings;
//      the indirection served no one and was a second coordination surface.
//   2. provider_credentials row, kind=oauth → refresh-under-lock when
//      expired, return the access token. Locking is per-row in SQLite
//      (last-writer-wins, no torn JSON) rather than via a file lock.
//
// Custom-provider credentials live in the same `provider_credentials`
// table as everyone else's — there is no separate models.json /
// fallback resolver path. A keyless custom provider (Ollama) simply
// has no row, and `hasAuth` returns false.
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/auth-storage.ts) — MIT.

import type { AuthInteraction, OAuthAuth, OAuthCredentials, ProviderId } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { IProviderCredentialStore } from "@fragua/store";
import { SqliteAuthStorageBackend } from "./sqlite-auth-backend.ts";

/** Deadline for a single OAuth token refresh. Generous against a slow token
 * endpoint, decisive against a hung one: past this the call is worse than a
 * failure, because it holds every LLM node waiting on the credential. */
const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

/** How long a failed refresh suppresses the next attempt for that provider.
 * Without it a revoked or unreachable token endpoint costs every LLM call the
 * full refresh timeout, serialized through the store lock — the credential
 * stays expired, so each call retries from scratch. Short enough that a
 * transient outage self-heals within a node's retry budget. */
const OAUTH_REFRESH_BACKOFF_MS = 60_000;

/** `oauth.refresh` with a deadline on its signal. `getApiKey` runs on every LLM
 * invocation, so an unbounded refresh is not a slow call — it wedges every node
 * waiting on the credential until the process restarts, with no daemon-internal
 * escape (the `login` path can at least defer to an interaction signal; there is
 * no interaction here). The signal is the provider's own cancellation channel,
 * so the deadline unwinds the in-flight request rather than orphaning it. */
export async function refreshWithDeadline(
  oauth: Pick<OAuthAuth, "refresh">,
  cred: Parameters<OAuthAuth["refresh"]>[0],
  timeoutMs: number = OAUTH_REFRESH_TIMEOUT_MS,
): Promise<Awaited<ReturnType<OAuthAuth["refresh"]>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`OAuth token refresh exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await oauth.refresh(cred, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Built-in OAuth providers, keyed by provider id. pi-ai exposes OAuth as
 * `Provider.auth.oauth` rather than a global registry now; the built-in set
 * is static, so it is memoised on first read. */
let oauthProvidersCache: Map<string, OAuthAuth> | undefined;
function builtinOAuthProviders(): Map<string, OAuthAuth> {
  if (!oauthProvidersCache) {
    const map = new Map<string, OAuthAuth>();
    for (const provider of builtinProviders()) {
      if (provider.auth.oauth) map.set(provider.id, provider.auth.oauth);
    }
    oauthProvidersCache = map;
  }
  return oauthProvidersCache;
}

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/** Purely in-memory — tests. */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const { result, next } = await fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
}

export { SqliteAuthStorageBackend };

/** Credential storage backed by the global store (or in-memory, for tests). */
export class AuthStorage {
  private errors: Error[] = [];

  private constructor(private storage: AuthStorageBackend) {}

  /** Read the current credential map from the backend on every call.
   * No in-memory cache: a CLI process writing to `provider_credentials`
   * is visible to a long-running daemon immediately. The backend's own
   * lock semantics (file lock for `FileAuthStorageBackend`, txn for
   * `SqliteAuthStorageBackend`) make this a small constant-time read. */
  private current(): AuthStorageData {
    let data: AuthStorageData = {};
    try {
      this.storage.withLock((str) => {
        data = this.parseStorageData(str);
        return { result: undefined };
      });
    } catch (error) {
      this.recordError(error);
    }
    return data;
  }

  /** Canonical factory: read credentials from the fragua store's
   *  `provider_credentials` table. */
  static fromStore(store: IProviderCredentialStore): AuthStorage {
    return new AuthStorage(new SqliteAuthStorageBackend(store));
  }

  /** Construct an AuthStorage against an arbitrary backend (tests,
   *  alternative persistence experiments). */
  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data) }));
    return AuthStorage.fromStorage(storage);
  }

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) return {};
    return JSON.parse(content) as AuthStorageData;
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) merged[provider] = credential;
        else delete merged[provider];
        return { result: undefined, next: JSON.stringify(merged) };
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  get(provider: string): AuthCredential | undefined {
    return this.current()[provider] ?? undefined;
  }

  set(provider: string, credential: AuthCredential): void {
    this.persistProviderChange(provider, credential);
  }

  remove(provider: string): void {
    this.persistProviderChange(provider, undefined);
  }

  list(): string[] {
    return Object.keys(this.current());
  }

  has(provider: string): boolean {
    return provider in this.current();
  }

  /** Any form of auth configured? Doesn't refresh OAuth tokens. */
  hasAuth(provider: string): boolean {
    return this.current()[provider] != null;
  }

  /** Describe where `getApiKey(provider)` would read from, for the
   * user-facing CLI diagnostic. Never returns the key itself. */
  describeAuthSource(provider: string): string | null {
    const cred = this.current()[provider];
    if (cred?.type === "api_key") return "stored api_key";
    if (cred?.type === "oauth") return "stored oauth";
    return null;
  }

  getAll(): AuthStorageData {
    return this.current();
  }

  /** Last failed refresh per provider — the backoff window's only state. */
  private readonly refreshFailedAt = new Map<string, number>();

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  /** Run the provider's OAuth login flow and persist the returned
   * credentials. See `getOAuthProviders()` for available provider ids. */
  async login(providerId: ProviderId, interaction: AuthInteraction): Promise<void> {
    const oauth = builtinOAuthProviders().get(providerId);
    if (!oauth) throw new Error(`Unknown OAuth provider: ${providerId}`);
    // `ProviderAuthInteraction` requires a signal, so this controller exists to
    // satisfy that when the caller supplies none — it is deliberately never
    // aborted, and no deadline belongs here. Unlike the refresh path, which the
    // daemon walks unattended on every LLM call, login is only ever reached from
    // the foreground `fragua providers login`, where the human waiting on a
    // browser flow is the timeout and SIGINT is the escape. A cap generous
    // enough not to cut that flow short would not bound anything worth bounding.
    const controller = new AbortController();
    const credential = await oauth.login({ ...interaction, signal: interaction.signal ?? controller.signal });
    this.set(providerId, { ...credential });
  }

  logout(provider: string): void {
    this.remove(provider);
  }

  /** OAuth refresh under the backend lock. SQLite per-row writes are
   * atomic; concurrent racers persist the same refreshed token
   * (last-writer-wins). The lock does NOT span the network refresh
   * itself — see `SqliteAuthStorageBackend.withLockAsync`. */
  private async refreshOAuthTokenWithLock(
    providerId: ProviderId,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    const oauth = builtinOAuthProviders().get(providerId);
    if (!oauth) return null;
    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      const cred = currentData[providerId];
      if (cred?.type !== "oauth") return { result: null };
      if (Date.now() < cred.expires) {
        const auth = await oauth.toAuth(cred);
        return { result: auth.apiKey ? { apiKey: auth.apiKey, newCredentials: cred } : null };
      }
      const refreshed = await refreshWithDeadline(oauth, cred);
      const auth = await oauth.toAuth(refreshed);
      const persisted: AuthStorageData = { ...currentData, [providerId]: { ...refreshed } };
      if (!auth.apiKey) {
        // The exchange SUCCEEDED — only the key derivation came up empty. The
        // server may have rotated the refresh token in that exchange, so
        // dropping `refreshed` here leaves the consumed one in storage and
        // every later attempt fails against a token the server already spent.
        // Persist it and report no key; the caller's backoff handles the rest.
        return { result: null, next: JSON.stringify(persisted) };
      }
      return { result: { apiKey: auth.apiKey, newCredentials: refreshed }, next: JSON.stringify(persisted) };
    });
    return result;
  }

  /**
   * Resolve the provider's API key.
   *
   * Priority:
   *   1. provider_credentials row, kind=api_key → verbatim key.
   *   2. provider_credentials row, kind=oauth   → locked refresh
   *      when expired, otherwise the cached access token.
   *   3. otherwise undefined.
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const cred = this.current()[providerId];
    if (cred?.type === "api_key") return cred.key;

    if (cred?.type === "oauth") {
      const oauth = builtinOAuthProviders().get(providerId);
      if (!oauth) return undefined;
      const needsRefresh = Date.now() >= cred.expires;
      if (needsRefresh) {
        const failedAt = this.refreshFailedAt.get(providerId);
        if (failedAt !== undefined && Date.now() - failedAt < OAUTH_REFRESH_BACKOFF_MS) {
          // Inside the window a recent failure stands in for the attempt, so a
          // revoked credential fails fast instead of charging every call the
          // refresh timeout.
          return undefined;
        }
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) {
            this.refreshFailedAt.delete(providerId);
            return result.apiKey;
          }
          this.refreshFailedAt.set(providerId, Date.now());
          // A null return is the non-throwing failure: the refresh completed
          // but yielded no usable key. Without this the caller gets `undefined`
          // indistinguishable from "no credential configured", `drainErrors()`
          // stays empty, and every later call silently re-runs the refresh.
          this.recordError(new Error(`OAuth refresh for ${providerId} produced no API key`));
        } catch (error) {
          this.refreshFailedAt.set(providerId, Date.now());
          this.recordError(error);
          // Another process may have refreshed meanwhile — re-read.
          const updatedCred = this.current()[providerId];
          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            // Another process won the refresh, so our throw was a race, not a
            // broken credential — don't hold the backoff against it.
            this.refreshFailedAt.delete(providerId);
            return (await oauth.toAuth(updatedCred)).apiKey;
          }
          return undefined;
        }
      } else {
        return (await oauth.toAuth(cred)).apiKey;
      }
    }

    return undefined;
  }

  /** The login-capable built-in providers, as `{ id, name }`. Handy for
   * CLI / server surfaces that iterate over the OAuth providers. */
  getOAuthProviders(): Array<{ id: string; name: string }> {
    return [...builtinOAuthProviders().entries()].map(([id, oauth]) => ({ id, name: oauth.name }));
  }
}
