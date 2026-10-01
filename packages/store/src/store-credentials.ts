import {
  deleteProviderCredential as queryDeleteProviderCredential,
  upsertProviderCredential as queryUpsertProviderCredential,
  selectAllProviderCredentials,
  selectProviderCredential,
} from "./provider-credentials-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { rowToProviderCredential } from "./store-rows.ts";
import type { ProviderCredentialRow } from "./types.ts";

export function getProviderCredential(ctx: StoreCtx, provider: string): ProviderCredentialRow | null {
  const row = selectProviderCredential(ctx.db, provider);
  return row == null ? null : rowToProviderCredential(row);
}

export function listProviderCredentials(ctx: StoreCtx): ProviderCredentialRow[] {
  return selectAllProviderCredentials(ctx.db).map(rowToProviderCredential);
}

export function upsertProviderCredential(
  ctx: StoreCtx,
  args: { provider: string; kind: "api_key" | "oauth"; payload: string },
): void {
  // Caller passes pre-stringified `payload` per invariant I1 —
  // JSON.stringify must not run inside the write txn.
  const now = ctx.now();
  ctx.writeTxn(() => {
    queryUpsertProviderCredential(ctx.db, {
      provider: args.provider,
      kind: args.kind,
      payload: args.payload,
      now,
    });
  });
}

export function deleteProviderCredential(ctx: StoreCtx, provider: string): void {
  ctx.writeTxn(() => {
    queryDeleteProviderCredential(ctx.db, provider);
  });
}
