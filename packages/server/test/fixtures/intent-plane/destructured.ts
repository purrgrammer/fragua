// Fixture (R2-M4): a write method destructured off the store, then called bare.

interface WriteStore {
  enqueueRun(params: unknown): void;
}

export function enqueueDestructured(store: WriteStore, p: unknown): void {
  const { enqueueRun } = store;
  enqueueRun(p);
}
