// Fixture: a helper OUTSIDE handlers/ that performs the external call on the
// handler's behalf. The external-side-effect lint must follow the import graph
// here to see `ctx.externalCall` and clear the delegating handler.

export function callExternal(ctx: { externalCall: (x: unknown) => unknown }): unknown {
  return ctx.externalCall({});
}
