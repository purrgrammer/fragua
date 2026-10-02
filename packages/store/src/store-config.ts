import {
  deleteProviderConfig as queryDeleteProviderConfig,
  upsertProviderConfig as queryUpsertProviderConfig,
  selectAllProviderConfigs,
  selectProviderConfig,
  selectProviderConfigRevision,
} from "./provider-config-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { rowToProviderConfig } from "./store-rows.ts";
import type { ProviderConfigRow } from "./types.ts";

export function getProviderConfig(ctx: StoreCtx, provider: string): ProviderConfigRow | null {
  const row = selectProviderConfig(ctx.db, provider);
  return row == null ? null : rowToProviderConfig(row);
}

export function listProviderConfigs(ctx: StoreCtx): ProviderConfigRow[] {
  return selectAllProviderConfigs(ctx.db).map(rowToProviderConfig);
}

export function upsertProviderConfig(ctx: StoreCtx, args: { provider: string; config: string }): void {
  // Caller passes pre-stringified `config` per invariant I1 —
  // JSON.stringify must not run inside the write txn.
  const now = ctx.now();
  ctx.writeTxn(() => {
    queryUpsertProviderConfig(ctx.db, {
      provider: args.provider,
      config: args.config,
      now,
    });
  });
}

export function deleteProviderConfig(ctx: StoreCtx, provider: string): void {
  ctx.writeTxn(() => {
    queryDeleteProviderConfig(ctx.db, provider);
  });
}

export function getProviderConfigRevision(ctx: StoreCtx): { maxUpdatedAt: number; rowCount: number } {
  const row = selectProviderConfigRevision(ctx.db);
  return { maxUpdatedAt: row.max_updated_at, rowCount: row.row_count };
}
