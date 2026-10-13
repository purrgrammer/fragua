// Fixture: a store sub-interface module that serializes through the façade's
// `ctx.validatePayload` INSIDE the write txn. The call resolves to neither a
// same-file helper nor a named import, so only `StoreCtx` resolution catches it.

import type { StoreCtx } from "../../../src/store-ctx.ts";

export function writeWithCtx(ctx: StoreCtx, p: unknown, sink: (s: string) => void): void {
  ctx.writeTxn(() => {
    sink(ctx.validatePayload(p));
  });
}
