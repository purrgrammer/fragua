// Fixture: a route module added without anyone remembering to list it. The
// directory-based scan must pick it up and flag the raw store read.

export function newRoute(opts: { store: { getState(id: string): unknown } }): unknown {
  const { store } = opts;
  return store.getState("run-1");
}
