// Fault-injection wrapper over an IEventStore — the store seam for the
// executor stress harness. The store is THE coordination surface, so making
// its `appendFact` (the commit) fail on a chosen call covers the bulk of the
// north-star fault list at the boundary where faults actually happen:
//
//   - "occ"   → throw ConcurrencyError, exactly as a real concurrent advance
//               does (store.ts version mismatch). tryAppendFact catches it →
//               the executor's OCC controller retries / eventually halts.
//   - "error" → throw a generic Error. tryAppendFact rethrows (non-OCC), it
//               escapes runOne, runOneSafe catches it, and the run is left in
//               its current durable state — the "store/commit failed, daemon
//               died mid-turn" shape that the next startupSweep recovers.
//   - "drop"  → silently swallow the commit (return as if it landed without
//               writing). Models a lost write — the orphan-side-effect shape
//               when the dropped fact is a `_done`.
//
// A thin Proxy: every method delegates to the inner store (bound to it, so
// SqliteStore's private fields resolve), except `appendFact`, which consults
// the schedule first. Internal store self-calls bypass the proxy (they run on
// the inner instance), so only the executor's commits are faulted.

import { ConcurrencyError, type FactEvent, type IEventStore } from "@fragua/store";

export type FaultKind = "occ" | "error" | "drop" | "ok";

/** Decide the fault for the Nth `appendFact` call (1-based), given the facts
 * about to be committed. Return "ok" to let it through. */
export type AppendFaultSchedule = (callIndex: number, facts: FactEvent[]) => FaultKind;

export interface FaultStoreHandle {
  store: IEventStore;
  /** Total `appendFact` calls the executor made through the wrapper. */
  appendCalls(): number;
  /** How many were faulted (occ/error/drop). */
  faultsInjected(): number;
}

/** Wrap `inner` so its `appendFact` is governed by `schedule`. */
export function faultStore(inner: IEventStore, schedule: AppendFaultSchedule): FaultStoreHandle {
  let calls = 0;
  let faults = 0;

  const appendFact: IEventStore["appendFact"] = (runId, facts, expectedVersion, opts) => {
    const n = ++calls;
    const kind = schedule(n, facts);
    if (kind !== "ok") faults++;
    switch (kind) {
      case "occ":
        // The exact signal a real version conflict raises (store.ts).
        throw new ConcurrencyError(expectedVersion, expectedVersion + 1);
      case "error":
        throw new Error(`injected store failure on appendFact #${n}`);
      case "drop":
        // Pretend the commit landed; return a committed-shaped result without
        // writing (version unchanged, no seqs).
        return { committed: true, newVersion: expectedVersion, seqs: [] };
      default:
        return inner.appendFact(runId, facts, expectedVersion, opts);
    }
  };

  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "appendFact") return appendFact;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as IEventStore;

  return { store, appendCalls: () => calls, faultsInjected: () => faults };
}
