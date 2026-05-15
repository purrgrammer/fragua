// SQL + typed helpers for the `provider_config` table.
// See docs/proposals/provider-config-storage.md.
//
// Per AGENTS.md backend skill: every literal SQL string touching
// `provider_config` lives here. `store.ts` owns the transaction
// boundary and parses the JSON `config` blob at its boundary; this
// module stays free of JSON.stringify / parse calls so invariant I1
// (no JSON.stringify inside write transactions) is structurally
// guaranteed at the caller.

import type { Database } from "bun:sqlite";

export interface ProviderConfigDbRow {
  provider: string;
  config: string;
  created_at: number;
  updated_at: number;
}

const SELECT_PROVIDER_CONFIG_SQL = `
  SELECT provider, config, created_at, updated_at
    FROM provider_config
   WHERE provider = ?
`;

export function selectProviderConfig(db: Database, provider: string): ProviderConfigDbRow | null {
  return db.query<ProviderConfigDbRow, [string]>(SELECT_PROVIDER_CONFIG_SQL).get(provider) ?? null;
}

const SELECT_ALL_PROVIDER_CONFIGS_SQL = `
  SELECT provider, config, created_at, updated_at
    FROM provider_config
   ORDER BY provider ASC
`;

export function selectAllProviderConfigs(db: Database): ProviderConfigDbRow[] {
  return db.query<ProviderConfigDbRow, []>(SELECT_ALL_PROVIDER_CONFIGS_SQL).all();
}

// `created_at` is intentionally absent from the UPDATE clause: a
// conflict preserves the original insert timestamp. `updated_at`
// always advances.
const UPSERT_PROVIDER_CONFIG_SQL = `
  INSERT INTO provider_config (provider, config, created_at, updated_at)
       VALUES (?, ?, ?, ?)
  ON CONFLICT(provider) DO UPDATE SET
      config     = excluded.config,
      updated_at = excluded.updated_at
`;

export function upsertProviderConfig(
  db: Database,
  args: {
    provider: string;
    config: string;
    now: number;
  },
): void {
  db.query(UPSERT_PROVIDER_CONFIG_SQL).run(args.provider, args.config, args.now, args.now);
}

const DELETE_PROVIDER_CONFIG_SQL = `
  DELETE FROM provider_config WHERE provider = ?
`;

export function deleteProviderConfig(db: Database, provider: string): void {
  db.query(DELETE_PROVIDER_CONFIG_SQL).run(provider);
}
