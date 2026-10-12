// Fixture: a handler module that keeps its own body clean and delegates the
// forbidden I/O to a sibling helper. A per-file scan of this file finds nothing;
// the transitive scan must reach `helper.ts` and flag the `node:fs` import.

import { readConfig } from "./helper.ts";

export function makeDelegatingHandler(): { kind: string; handler: () => string } {
  return { kind: "delegating", handler: () => readConfig() };
}
