// A run fiber's view of the store: every claim-holder write — `appendFact`,
// `appendMessage`, `putArtifact`, `appendObservabilityEvents` — carries the
// claim epoch the fiber was dispatched under, so the store rejects it with
// `ClaimLostError` once a crash requeue or a re-claim has handed the run to
// another fiber. Wrapping the store once at fiber entry covers every write
// site (linear turn, fan-out lane, recorder, snapshot, handler ctx, telemetry
// flush) without threading the epoch through each call.

import type { IEventWriter } from "@fragua/store";

type ClaimBoundWrites = Pick<
  IEventWriter,
  "appendFact" | "appendMessage" | "putArtifact" | "appendObservabilityEvents"
>;

export function bindClaim<S extends ClaimBoundWrites>(store: S, claimEpoch: number): S {
  const bound: ClaimBoundWrites = {
    appendFact: (runId, events, expectedVersion, opts) =>
      store.appendFact(runId, events, expectedVersion, { ...opts, claimEpoch }),
    appendMessage: (runId, row, opts) => store.appendMessage(runId, row, { ...opts, claimEpoch }),
    putArtifact: (scope, content, mime, opts) => store.putArtifact(scope, content, mime, { ...opts, claimEpoch }),
    appendObservabilityEvents: (runId, events, opts) =>
      store.appendObservabilityEvents(runId, events, { ...opts, claimEpoch }),
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (Object.hasOwn(bound, prop)) return bound[prop as keyof ClaimBoundWrites];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
