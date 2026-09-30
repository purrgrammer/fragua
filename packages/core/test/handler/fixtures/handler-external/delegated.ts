// Fixture: a handler that declares `sideEffect: "external"` but routes the
// actual `ctx.externalCall` through an imported helper module. The old per-file
// regex missed the delegation and would have flagged this; the AST + import-graph
// scan must NOT flag it.

import { callExternal } from "./helper.ts";

export function makeDelegatedHandler(): { kind: string; sideEffect: string; handler: (ctx: unknown) => unknown } {
  return {
    kind: "delegated",
    sideEffect: "external",
    handler: (ctx) => callExternal(ctx as { externalCall: (x: unknown) => unknown }),
  };
}
