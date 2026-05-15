// Credential storage for API keys and OAuth tokens. Persists into the
// global swarm store (`provider_credentials` table) — see
// docs/proposals/provider-credentials-storage.md.
//
// Resolution order (much shorter than the prior file-backed version):
//   1. provider_credentials row, kind=api_key → return the stored key verbatim.
//      No !cmd / env-var resolution: keys are short literal strings;
//      the indirection served no one and was a second coordination surface.
//   2. provider_credentials row, kind=oauth → refresh-under-lock when
//      expired, return the access token. Locking is per-row in SQLite
//      (last-writer-wins, no torn JSON) rather than via a file lock.
//   3. fallback resolver — for custom-provider keys still living in
//      ~/.swarm/models.json. The follow-up provider-config-storage
//      proposal moves these too; the hook stays until then.
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/auth-storage.ts) — MIT.

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderId } from "@mariozechner/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import type { IProviderCredentialStore } from "@swarm/store";
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
  private data: AuthStorageData = {};
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];

  private constructor(private storage: AuthStorageBackend) {
    this.reload();
  }

  /** Canonical factory: read credentials from the swarm store's
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

  /** ModelRegistry registers its custom-provider key resolver here so
   * the `getApiKey(provider)` chain can fall through to models.json.
   * Removed in the follow-up provider-config-storage proposal. */
  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.fallbackResolver = resolver;
  }

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) return {};
    return JSON.parse(content) as AuthStorageData;
  }

  /** Re-read credentials from the backend. */
  reload(): void {
    let content: string | undefined;
    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: undefined };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      this.loadError = error as Error;
      this.recordError(error);
    }
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    if (this.loadError) return;
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
    return this.data[provider] ?? undefined;
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persistProviderChange(provider, credential);
  }

  remove(provider: string): void {
    delete this.data[provider];
    this.persistProviderChange(provider, undefined);
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  has(provider: string): boolean {
    return provider in this.data;
  }

  /** Any form of auth configured? Doesn't refresh OAuth tokens. */
  hasAuth(provider: string): boolean {
    if (this.data[provider]) return true;
    if (this.fallbackResolver?.(provider)) return true;
    return false;
  }

  /** Describe where `getApiKey(provider)` would read from, for the
   * user-facing CLI diagnostic. Never returns the key itself. */
  describeAuthSource(provider: string): string | null {
    const cred = this.data[provider];
    if (cred?.type === "api_key") return "stored api_key";
    if (cred?.type === "oauth") return "stored oauth";
    if (this.fallbackResolver?.(provider)) return "models.json custom provider";
    return null;
  }

  getAll(): AuthStorageData {
    return { ...this.data };
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
      this.data = currentData;
      this.loadError = null;
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
      this.data = merged;
      this.loadError = null;
      return { result: refreshed, next: JSON.stringify(merged) };
    });
    return result;
  }

  /**
   * Resolve the provider's API key.
   *
   * Priority:
   *   1. provider_credentials row (api_key → verbatim; oauth → locked refresh)
   *   2. Fallback resolver (ModelRegistry custom providers from models.json)
   */
  async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
    const cred = this.data[providerId];
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
          // Another process may have refreshed meanwhile.
          this.reload();
          const updatedCred = this.data[providerId];
          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            return provider.getApiKey(updatedCred);
          }
          return undefined;
        }
      } else {
        return provider.getApiKey(cred);
      }
    }

    if (options?.includeFallback !== false) {
      return this.fallbackResolver?.(providerId) ?? undefined;
    }
    return undefined;
  }

  /** Pass-through to pi-ai's OAuth registry. Handy for CLI surfaces
   * that want to iterate over the login-capable providers. */
  getOAuthProviders() {
    return getOAuthProviders();
  }
}
