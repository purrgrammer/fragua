// SQL + typed helpers for the `provider_credentials` table.
//
// Per AGENTS.md backend skill: every literal SQL string touching
// `provider_credentials` lives here. `store.ts` owns the transaction
// boundary and parses the JSON `payload` at its boundary; this module
// stays free of JSON.stringify / parse calls so invariant I1 (no
// JSON.stringify inside write transactions) is structurally guaranteed
// at the caller.

import type { Database } from "bun:sqlite";

export interface ProviderCredentialDbRow {
  provider: string;
  kind: "api_key" | "oauth";
  payload: string;
  created_at: number;
  updated_at: number;
}

const SELECT_PROVIDER_CREDENTIAL_SQL = `
  SELECT provider, kind, payload, created_at, updated_at
    FROM provider_credentials
   WHERE provider = ?
`;

export function selectProviderCredential(db: Database, provider: string): ProviderCredentialDbRow | null {
  return db.query<ProviderCredentialDbRow, [string]>(SELECT_PROVIDER_CREDENTIAL_SQL).get(provider) ?? null;
}

const SELECT_ALL_PROVIDER_CREDENTIALS_SQL = `
  SELECT provider, kind, payload, created_at, updated_at
    FROM provider_credentials
   ORDER BY provider ASC
`;

export function selectAllProviderCredentials(db: Database): ProviderCredentialDbRow[] {
  return db.query<ProviderCredentialDbRow, []>(SELECT_ALL_PROVIDER_CREDENTIALS_SQL).all();
}

// `created_at` is intentionally absent from the UPDATE clause: a conflict
// preserves the original insert timestamp. `updated_at` always advances.
const UPSERT_PROVIDER_CREDENTIAL_SQL = `
  INSERT INTO provider_credentials (provider, kind, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(provider) DO UPDATE SET
      kind       = excluded.kind,
      payload    = excluded.payload,
      updated_at = excluded.updated_at
`;

export function upsertProviderCredential(
  db: Database,
  args: {
    provider: string;
    kind: "api_key" | "oauth";
    payload: string;
    now: number;
  },
): void {
  db.query(UPSERT_PROVIDER_CREDENTIAL_SQL).run(args.provider, args.kind, args.payload, args.now, args.now);
}

const DELETE_PROVIDER_CREDENTIAL_SQL = `
  DELETE FROM provider_credentials WHERE provider = ?
`;

export function deleteProviderCredential(db: Database, provider: string): void {
  db.query(DELETE_PROVIDER_CREDENTIAL_SQL).run(provider);
}
