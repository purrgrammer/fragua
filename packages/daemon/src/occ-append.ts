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

/**
 * Outcome of a single dispatch turn. `dispatchOne` (and `commitParkOrTerminal`)
 * return this so the outer loop can decide whether to continue iterating or exit
 * (the run reached a terminal / paused state, or another short-circuit).
 */
export type DispatchOutcome = { kind: "terminal" } | { kind: "continue" };

/** Outcome of a serialized commit. A tagged `false`: `occ` is a genuine OCC
 * conflict (feed the conflict controller), `status` is the run leaving `running`
 * under us (already parked — don't). */
export type CommitResult = { ok: true } | { ok: false; reason: "occ" | "status" };

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
              type: "fact.run_terminated",
              payload: {
                status: "errored",
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

export interface ParkOrTerminalDeps {
  store: IEventWriter & IEventReader;
  runId: string;
  /** The per-`runOne` conflict controller (warn / halt escalation). */
  occ: OccController;
  /** Node id + iteration stamped onto the conflict / warn payloads. */
  nodeId: string;
  iteration: number;
  /** Version the DEFAULT single-attempt commit checks against. */
  expectedVersion: number;
  /** Routing patch / applied-seq advance for the default commit. */
  appendOpts?: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number };
  /** The commit primitive. Defaults to a single `tryAppendFact` against
   * `expectedVersion`, re-reading state to tell a status-stop from an OCC
   * conflict. The fan-out lane passes its serialized `commitFanoutFact`, which
   * already makes that distinction. */
  commit?: (facts: FactEvent[]) => Promise<CommitResult>;
  /** Park/clear hook. Called with the facts when an OCC conflict parks them for
   * a re-commit next turn, and with `undefined` when the park is cleared (the
   * commit landed, the run already left `running`, or the controller halted).
   * The fan-out lane threads its `pendingFanoutDisposition` slot through it. */
  onPark?: (facts: FactEvent[] | undefined) => void;
}

/** Commit a run-parking or terminal fact batch HONESTLY — the run never stays
 * `running` with the fact silently lost on a lost OCC race (ARCH §1.6). On
 * success the turn ends. On an OCC conflict we re-read: if the run already left
 * `running`, someone else parked it (return terminal, append nothing); otherwise
 * drive the shared conflict controller — halt `occ_exhausted` at the ceiling
 * (terminal), else park the facts for a re-commit next turn (continue). Shared
 * by the linear and fan-out paths so neither can strand the run. */
export async function commitParkOrTerminal(deps: ParkOrTerminalDeps, facts: FactEvent[]): Promise<DispatchOutcome> {
  const { store, runId, occ, nodeId, iteration, expectedVersion, onPark } = deps;
  const commit =
    deps.commit ??
    (async (f: FactEvent[]): Promise<CommitResult> => {
      const ok = await tryAppendFact(store, runId, expectedVersion, f, deps.appendOpts);
      if (ok) return { ok: true };
      const fresh = store.getState(runId);
      if (fresh == null || fresh.status !== "running") return { ok: false, reason: "status" };
      return { ok: false, reason: "occ" };
    });

  const res = await commit(facts);
  if (res.ok || res.reason === "status") {
    onPark?.(undefined);
    return { kind: "terminal" };
  }
  const { halted } = await occ.onConflict(facts[0]?.type ?? "fact.unknown", nodeId, iteration, expectedVersion);
  if (halted) {
    onPark?.(undefined);
    return { kind: "terminal" };
  }
  onPark?.(facts);
  return { kind: "continue" };
}
