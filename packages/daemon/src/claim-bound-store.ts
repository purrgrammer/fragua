// A run fiber's view of the store: every `appendFact` carries the claim epoch
// the fiber was dispatched under, so the store rejects the write with
// `ClaimLostError` once a crash requeue or a re-claim has handed the run to
// another fiber. Wrapping the store once at fiber entry covers every commit
// site (linear turn, fan-out lane, recorder, snapshot) without threading the
// epoch through each call.

import type { AppendFactOpts, IEventWriter } from "@fragua/store";

export function bindClaim<S extends Pick<IEventWriter, "appendFact">>(store: S, claimEpoch: number): S {
  const appendFact: IEventWriter["appendFact"] = (runId, events, expectedVersion, opts) => {
    const withEpoch: AppendFactOpts = { ...opts, claimEpoch };
    return store.appendFact(runId, events, expectedVersion, withEpoch);
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "appendFact") return appendFact;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
