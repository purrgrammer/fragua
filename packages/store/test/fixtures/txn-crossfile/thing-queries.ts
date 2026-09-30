// Fixture: a cross-file `*-queries.ts` helper that a txn body calls. It routes a
// `JSON.stringify` under the write lock — the exact hole the old same-file-only
// scan missed. The import-graph follow must reach this body and flag it.

export function insertThing(p: unknown): string {
  return JSON.stringify(p);
}
