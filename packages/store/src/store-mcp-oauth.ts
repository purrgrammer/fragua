import {
  deleteMcpOAuth as queryDeleteMcpOAuth,
  upsertMcpOAuth as queryUpsertMcpOAuth,
  selectAllMcpOAuth,
  selectMcpOAuth,
} from "./mcp-oauth-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";

export function getMcpOAuth(ctx: StoreCtx, url: string): string | undefined {
  const row = selectMcpOAuth(ctx.db, url);
  return row == null ? undefined : row.payload;
}

export function listMcpOAuth(ctx: StoreCtx): { url: string; payload: string }[] {
  return selectAllMcpOAuth(ctx.db).map((row) => ({ url: row.url, payload: row.payload }));
}

export function upsertMcpOAuth(ctx: StoreCtx, url: string, payload: string): void {
  // Caller passes a pre-stringified opaque `payload` per invariant I1 —
  // JSON.stringify must not run inside the write txn.
  const now = ctx.now();
  ctx.writeTxn(() => {
    queryUpsertMcpOAuth(ctx.db, { url, payload, now });
  });
}

export function deleteMcpOAuth(ctx: StoreCtx, url: string): void {
  ctx.writeTxn(() => {
    queryDeleteMcpOAuth(ctx.db, url);
  });
}
