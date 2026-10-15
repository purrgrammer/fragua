// Fixture (R2-M1): `JSON["stringify"]` inside a write txn — a literal-key
// element access that call-name text matching alone does not see.

import type { StoreCtx } from "../../../src/store-ctx.ts";

export function writeBracketed(ctx: StoreCtx, p: unknown, sink: (s: string) => void): void {
  ctx.writeTxn(() => {
    sink(JSON["stringify"](p));
  });
}
