// Fixture (R2-M4): a write method invoked through `Function.prototype.call`.

interface WriteStore {
  enqueueRun(params: unknown): void;
}

export function enqueueViaCall(store: WriteStore, p: unknown): void {
  store.enqueueRun.call(store, p);
}
