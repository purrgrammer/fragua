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

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderId } from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import type { IProviderCredentialStore } from "@fragua/store";
import { SqliteAuthStorageBackend } from "./sqlite-auth-backend.ts";

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

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  /** Run the provider's OAuth login flow and persist the returned
   * credentials. See `getOAuthProviders()` for available provider ids. */
  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  logout(provider: string): void {
    this.remove(provider);
  }

  /** OAuth refresh under the backend lock. SQLite per-row writes are
   * atomic; concurrent racers persist the same refreshed token
   * (last-writer-wins). The lock does NOT span the network refresh
   * itself — see `SqliteAuthStorageBackend.withLockAsync`. */
  private async refreshOAuthTokenWithLock(
    providerId: OAuthProviderId,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return null;
    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      const cred = currentData[providerId];
      if (cred?.type !== "oauth") return { result: null };
      if (Date.now() < cred.expires) {
        return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
      }
      const oauthCreds: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(currentData)) {
        if (value.type === "oauth") oauthCreds[key] = value;
      }
      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) return { result: null };
      const merged: AuthStorageData = {
        ...currentData,
        [providerId]: { type: "oauth", ...refreshed.newCredentials },
      };
      return { result: refreshed, next: JSON.stringify(merged) };
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
      const provider = getOAuthProvider(providerId);
      if (!provider) return undefined;
      const needsRefresh = Date.now() >= cred.expires;
      if (needsRefresh) {
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) return result.apiKey;
        } catch (error) {
          this.recordError(error);
          // Another process may have refreshed meanwhile — re-read.
          const updatedCred = this.current()[providerId];
          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            return provider.getApiKey(updatedCred);
          }
          return undefined;
        }
      } else {
        return provider.getApiKey(cred);
      }
    }

    return undefined;
  }

  /** Pass-through to pi-ai's OAuth registry. Handy for CLI surfaces
   * that want to iterate over the login-capable providers. */
  getOAuthProviders() {
    return getOAuthProviders();
  }
}
