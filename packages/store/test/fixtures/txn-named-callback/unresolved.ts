// Fixture: the txn body comes from a factory call, so its contents can't be
// resolved statically — the lint must flag the call rather than pass it.

import type { StoreCtx } from "../../../src/store-ctx.ts";

function makeBody(p: unknown, sink: (s: string) => void): () => void {
  return () => sink(String(p));
}

export function writeUnresolved(ctx: StoreCtx, p: unknown, sink: (s: string) => void): void {
  ctx.writeTxn(makeBody(p, sink));
}
