// Store-backed AuthStorageBackend. The agent's `AuthStorage` was
// originally a thin wrapper over a JSON file + file lock; the
// credentials-in-the-store proposal moved persistence into the global
// SQLite store (`provider_credentials` table). This backend slots into
// the existing `AuthStorageBackend` seam so `AuthStorage` keeps its
// blob-shaped read/write contract unchanged.
//
// Read path: list rows → rebuild `AuthStorageData` blob → hand the
// stringified blob to the caller's `fn`.
//
// Write path (when `fn` returns `next`): diff the next blob against
// the rebuilt-current map → upsert each provider present in next →
// delete each provider absent from next. "Full-replace" semantics:
// correct at <20 rows and avoids per-row diff logic at the caller.
//
// OAuth refresh runs through `withLockAsync`, which crucially does NOT
// hold a SQLite write transaction across the network await. Racing
// daemon / serve processes refreshing the same OAuth provider both win
// (last writer persists). The refresh tokens are reusable for the
// pi-ai built-in providers; revisit if a provider lands with
// single-use refresh.

import type { IProviderCredentialStore, ProviderCredentialRow } from "@fragua/store";

type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

interface StoredCredential {
  type: "api_key" | "oauth";
  [k: string]: unknown;
}

function rebuildBlob(rows: ProviderCredentialRow[]): { blob: string; current: Record<string, StoredCredential> } {
  const current: Record<string, StoredCredential> = {};
  for (const row of rows) {
    current[row.provider] = row.payload as StoredCredential;
  }
  return { blob: JSON.stringify(current), current };
}

function applyDiff(
  store: IProviderCredentialStore,
  current: Record<string, StoredCredential>,
  next: Record<string, StoredCredential>,
): void {
  for (const [provider, cred] of Object.entries(next)) {
    const kind = cred.type === "oauth" ? "oauth" : "api_key";
    // JSON.stringify happens here (outside any SQLite transaction) so
    // invariant I1 (no JSON.stringify inside a write txn) is structurally
    // preserved at the store boundary.
    const payload = JSON.stringify(cred);
    store.upsertProviderCredential({ provider, kind, payload });
  }
  for (const provider of Object.keys(current)) {
    if (!(provider in next)) {
      store.deleteProviderCredential(provider);
    }
  }
}

function parseNextBlob(next: string): Record<string, StoredCredential> {
  const parsed = JSON.parse(next) as unknown;
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AuthStorage next blob must be a JSON object keyed by provider id");
  }
  return parsed as Record<string, StoredCredential>;
}

export class SqliteAuthStorageBackend implements AuthStorageBackend {
  constructor(private readonly store: IProviderCredentialStore) {}

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const rows = this.store.listProviderCredentials();
    const { blob, current } = rebuildBlob(rows);
    const { result, next } = fn(blob);
    if (next !== undefined) {
      const parsed = parseNextBlob(next);
      applyDiff(this.store, current, parsed);
    }
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    // Read outside any transaction; the caller is free to `await` (e.g.
    // OAuth refresh) without blocking the writer connection.
    const rows = this.store.listProviderCredentials();
    const { blob, current } = rebuildBlob(rows);
    const { result, next } = await fn(blob);
    if (next !== undefined) {
      const parsed = parseNextBlob(next);
      // Re-read current state right before the write so a racer's
      // refresh that landed during our await doesn't get clobbered
      // back to "absent" by our delete-missing pass.
      const freshRows = this.store.listProviderCredentials();
      const freshCurrent: Record<string, StoredCredential> = {};
      for (const row of freshRows) freshCurrent[row.provider] = row.payload as StoredCredential;
      // Union of "what we knew at read" and "what's there now" is the
      // safer baseline for delete-missing: a provider that existed at
      // read time and is absent from `next` is a legitimate delete; a
      // provider that arrived during our await stays.
      const baseline: Record<string, StoredCredential> = { ...freshCurrent, ...current };
      applyDiff(this.store, baseline, parsed);
    }
    return result;
  }
}
