// Credential storage for API keys and OAuth tokens. The file lives at
// ~/.swarm/auth.json (mode 0600, file-locked so concurrent daemons
// don't race on OAuth refresh).
//
// Resolution order mirrors pi-coding-agent:
//   1. runtime override (CLI --api-key)
//   2. auth.json api_key (resolved via resolve-config-value — !cmd /
//      env-var / literal, so the secret doesn't have to live in the
//      file)
//   3. auth.json oauth (refresh under file lock when expired)
//   4. env var (pi-ai's getEnvApiKey — handles the Anthropic OAuth-
//      over-API-key precedence, AWS's 6 credential sources, GCP ADC,
//      etc.)
//   5. fallback resolver (ModelRegistry's custom-provider keys from
//      models.json)
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/auth-storage.ts) — MIT. Upstream in
// @mariozechner/pi-mono. Revisit if the pi project splits this out.
//
// Swarm-specific deltas:
// - `getAgentDir()` → swarm's `resolveAuthPath()` (global + pi fallback).
// - Exposes the runtime override + fallback resolver hooks unchanged —
//   used by swarm CLI's `--api-key` flag and by ModelRegistry's custom-
//   provider key fallback respectively.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  getEnvApiKey,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId,
} from "@mariozechner/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { resolveAuthPath } from "./paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

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

export class FileAuthStorageBackend implements AuthStorageBackend {
  constructor(private authPath: string = resolveAuthPath()) {}

  private ensureParentDir(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private ensureFileExists(): void {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 0o600);
    }
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
        lastError = error;
        const start = Date.now();
        // Busy-wait without going async so sync callers stay sync.
        while (Date.now() - start < delayMs) {}
      }
    }
    throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();
    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.authPath);
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = fn(current);
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      return result;
    } finally {
      if (release) release();
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();
    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (lockCompromised) throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
    };
    try {
      release = await lockfile.lock(this.authPath, {
        retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
        stale: 30_000,
        onCompromised: (err) => {
          lockCompromised = true;
          lockCompromisedError = err;
        },
      });
      throwIfCompromised();
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock errors when lock is compromised.
        }
      }
    }
  }
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

/** Credential storage backed by a JSON file (or in-memory, for tests). */
export class AuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];

  private constructor(private storage: AuthStorageBackend) {
    this.reload();
  }

  /** Read `auth.json` at the resolved swarm path (with pi fallback). */
  static create(authPath?: string): AuthStorage {
    return new AuthStorage(new FileAuthStorageBackend(authPath ?? resolveAuthPath()));
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return AuthStorage.fromStorage(storage);
  }

  /** CLI `--api-key` override. Not persisted. */
  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /** ModelRegistry registers its custom-provider key resolver here so
   * the `getApiKey(provider)` chain can fall through to models.json. */
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

  /** Re-read `auth.json` from the backend. */
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
        return { result: undefined, next: JSON.stringify(merged, null, 2) };
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
    if (this.runtimeOverrides.has(provider)) return true;
    if (this.data[provider]) return true;
    if (getEnvApiKey(provider)) return true;
    if (this.fallbackResolver?.(provider)) return true;
    return false;
  }

  /** Describe where `getApiKey(provider)` would read from, for the
   * user-facing CLI diagnostic. Never returns the key itself. The
   * returned label is stable across runs for a given config (useful
   * in docs / support threads). */
  describeAuthSource(provider: string): string | null {
    if (this.runtimeOverrides.has(provider)) return "runtime override";
    const cred = this.data[provider];
    if (cred?.type === "api_key") {
      const k = cred.key;
      if (k.startsWith("!")) return `auth.json api_key (shell: ${k.slice(1, 48)}${k.length > 49 ? "…" : ""})`;
      if (process.env[k] !== undefined) return `auth.json api_key (env: ${k})`;
      return "auth.json api_key (literal)";
    }
    if (cred?.type === "oauth") return "auth.json oauth";
    // pi-ai's env-var map isn't exported (only getEnvApiKey(provider)
    // returns the value). Naming the specific variable would mean
    // mirroring the map and eating drift on every pi-ai release, so we
    // just label "env" and let the user `env | grep <PROVIDER>` if
    // they need the specific name. Revisit if pi-ai exports the map.
    if (getEnvApiKey(provider)) return "env";
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

  /** File-locked refresh. Multiple pi/swarm processes can race on
   * expired tokens; the lock ensures exactly one wins and the rest
   * read the refreshed value. */
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
      return { result: refreshed, next: JSON.stringify(merged, null, 2) };
    });
    return result;
  }

  /**
   * Resolve the provider's API key.
   *
   * Priority:
   *   1. Runtime override
   *   2. auth.json api_key (resolved via !cmd / env-var / literal)
   *   3. auth.json oauth (locked refresh when expired)
   *   4. pi-ai's getEnvApiKey
   *   5. Fallback resolver (ModelRegistry)
   */
  async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) return runtimeKey;

    const cred = this.data[providerId];
    if (cred?.type === "api_key") return resolveConfigValue(cred.key);

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

    const envKey = getEnvApiKey(providerId);
    if (envKey) return envKey;

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
