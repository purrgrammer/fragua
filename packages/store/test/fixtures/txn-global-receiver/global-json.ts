// Fixture (R3-M2): `globalThis.JSON.stringify` inside a write txn — a global
// receiver in front of a banned callee.

import type { StoreCtx } from "../../../src/store-ctx.ts";

export function writeGlobalReceiver(ctx: StoreCtx, p: unknown, sink: (s: string) => void): void {
  ctx.writeTxn(() => {
    sink(globalThis.JSON.stringify(p));
  });
}
