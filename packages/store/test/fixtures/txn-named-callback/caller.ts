// Fixture: the txn body is declared as a named const and passed by reference,
// so an inline-callback-only scan never sees the `JSON.stringify` inside it.

import type { StoreCtx } from "../../../src/store-ctx.ts";

export function writeNamed(ctx: StoreCtx, p: unknown, sink: (s: string) => void): void {
  const body = (): void => {
    sink(JSON.stringify(p));
  };
  ctx.writeTxn(body);
}
