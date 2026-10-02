// Fixture: a handler that declares `sideEffect: "external"` but never reaches
// `ctx.externalCall` anywhere in its import graph. The lint MUST flag it.

export function makeMissingHandler(): { kind: string; sideEffect: string; handler: (ctx: unknown) => unknown } {
  return {
    kind: "missing",
    sideEffect: "external",
    handler: () => ({ done: true }),
  };
}
