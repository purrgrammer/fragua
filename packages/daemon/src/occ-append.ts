// OCC fact-append helpers — the optimistic-concurrency append primitive plus
// the per-dispatch conflict controller extracted from executor.ts.
//
// `tryAppendFact` swallows a ConcurrencyError into a boolean so callers can
// branch on it. `makeOccController` owns the bounded-retry / warn / exhaustion
// behaviour that every append site shares: a wedged supervisor can make a turn
// conflict repeatedly, so each conflict backs off, OCC_WARN_AT emits one
// observability event, and OCC_CEILING halts the run with a structured
// `occ_exhausted` payload (the halt append itself is retried against fresh
// state — it can conflict too). The counter is in-memory, scoped to one
// runOne pass: a daemon restart re-enters with a fresh count, which is the
// correct semantics (the bug shape is "supervisor wedged this turn", which
// doesn't survive a process restart).

import { ConcurrencyError, type FactEvent, type IEventReader, type IEventWriter } from "@fragua/store";
import { sleep } from "./executor-helpers.ts";

export async function tryAppendFact(
  store: IEventWriter & IEventReader,
  runId: string,
  expectedVersion: number,
  facts: FactEvent[],
  opts?: {
    routingPatch?: Record<string, unknown>;
    advanceAppliedTo?: number;
  },
): Promise<boolean> {
  if (facts.length === 0) return true;
  try {
    store.appendFact(runId, facts, expectedVersion, opts);
    return true;
  } catch (err) {
    if (err instanceof ConcurrencyError) return false;
    throw err;
  }
}

const OCC_CEILING = 3;
const OCC_WARN_AT = 2;
const OCC_BACKOFF_CAP_MS = 16;

export interface OccController {
  /** Record an OCC conflict on an append. Backs off; warns once at
   * OCC_WARN_AT; at OCC_CEILING halts the run (`occ_exhausted`) and returns
   * `{ halted: true }`. Otherwise returns `{ halted: false }` — the caller
   * should re-read state and retry the turn. */
  onConflict(
    attemptedFactType: string,
    nodeId: string,
    iteration: number,
    lastVersion: number,
  ): Promise<{ halted: boolean }>;
  /** Record that an append landed. Emits `occ_conflict_resolved` if there
   * were prior conflicts this turn, then resets the counter. */
  onResolved(nodeId: string, iteration: number): void;
}

export function makeOccController(deps: {
  store: IEventWriter & IEventReader;
  runId: string;
  shutdownSignal: AbortSignal;
}): OccController {
  const { store, runId, shutdownSignal } = deps;
  let occCount = 0;
  let occWarned = false;

  return {
    onConflict: async (attemptedFactType, nodeId, iteration, lastVersion) => {
      occCount++;
      if (occCount >= OCC_CEILING) {
        // The occ_exhausted halt is itself a fact append and can itself
        // conflict (the same wedged-supervisor that produced the upstream
        // conflicts may still be committing). Retry it against fresh state
        // a bounded number of times so the run actually terminates instead
        // of returning `halted: true` while the halt fact never landed —
        // which left the run stranded `running`.
        const HALT_APPEND_MAX_ATTEMPTS = OCC_CEILING + 2;
        for (let attempt = 0; attempt < HALT_APPEND_MAX_ATTEMPTS; attempt++) {
          const fresh = store.getState(runId);
          // Already terminal (a concurrent writer halted/cancelled/completed
          // it) — nothing left to do.
          if (fresh == null || fresh.status !== "running") return { halted: true };
          const ok = await tryAppendFact(store, runId, fresh.version, [
            {
              type: "fact.run_halted",
              payload: {
                reason: "occ_exhausted",
                detail: `${occCount} consecutive OCC conflicts on ${attemptedFactType} for node ${nodeId}`,
                occContext: { count: occCount, nodeId, iteration, lastVersion, attemptedFactType },
              },
            },
          ]);
          if (ok) break;
          await sleep(Math.min(2 ** attempt, OCC_BACKOFF_CAP_MS), shutdownSignal);
        }
        return { halted: true };
      }
      if (occCount === OCC_WARN_AT && !occWarned) {
        store.appendObservabilityEvents(runId, [
          {
            type: "occ_conflict_warning",
            payload: { count: occCount, ceiling: OCC_CEILING, nodeId, iteration },
          },
        ]);
        occWarned = true;
      }
      // Exponential backoff: 1ms, 2ms, then capped at 16ms. Gives the
      // conflicting writer's commit a chance to land so the next OCC
      // version-read sees the advanced state.
      const delayMs = Math.min(2 ** (occCount - 1), OCC_BACKOFF_CAP_MS);
      await sleep(delayMs, shutdownSignal);
      return { halted: false };
    },
    onResolved: (nodeId, iteration) => {
      if (occCount > 0) {
        store.appendObservabilityEvents(runId, [
          {
            type: "occ_conflict_resolved",
            payload: { count: occCount, nodeId, iteration },
          },
        ]);
      }
      occCount = 0;
      occWarned = false;
    },
  };
}
