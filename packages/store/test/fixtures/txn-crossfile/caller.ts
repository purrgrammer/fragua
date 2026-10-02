// Fixture: a txn body that calls a function imported from another module. The
// banned `JSON.stringify` lives in the imported `thing-queries.ts`, not here, so
// only an import-graph follow catches it.

import { insertThing } from "./thing-queries.ts";

export function doWrite(writeTxn: (fn: () => void) => void, p: unknown): void {
  writeTxn(() => {
    insertThing(p);
  });
}
