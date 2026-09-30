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

/** Bound on retrying a terminal/parking fact append against fresh state when it
 * loses its OCC race. Shared by the OCC controller's `occ_exhausted` escalation
 * and the executor's mid-turn-crash recovery so both use the same ceiling. */
export const HALT_APPEND_MAX_ATTEMPTS = OCC_CEILING + 2;

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

/** The generalized OCC commit arm shared by every append site on both the
 * linear and fan-out paths. It commits `facts` through `commit`, then routes the
 * three outcomes uniformly so no arm can strand the run (ARCH §1.6):
 *  - success → run `onSuccess` (which may itself return a `DispatchOutcome` to
 *    override, e.g. an abort-loop pause commit), else return `successOutcome`;
 *  - the run left `running` under us (`status`) → return `statusOutcome`;
 *  - a genuine OCC conflict → drive the shared controller: halt `occ_exhausted`
 *    at the ceiling (terminal), else park (`onPark`) for a re-commit next turn
 *    (continue).
 * `onFail` fires the instant a commit fails (before classifying) and `onNonHalt`
 * before any non-halting continue/status exit — the fan-out arms use them to
 * abort + drain the in-flight pool. */
export interface OccCommitPlan {
  occ: OccController;
  nodeId: string;
  iteration: number;
  expectedVersion: number;
  /** Fact-type label for the conflict record; defaults to `facts[0].type`. */
  attemptedFactType?: string;
  /** The commit primitive (`occAppendOnce` on the linear path, the serialized
   *  `commitFanoutFact` on the fan-out path). */
  commit: (facts: FactEvent[]) => Promise<CommitResult>;
  /** Returned after a successful commit (post `onSuccess`). `undefined` means
   *  "proceed" — the fan-out pool keeps draining rather than exiting the turn. */
  successOutcome: DispatchOutcome | undefined;
  /** Returned when the run left `running` under us. `undefined` proceeds. */
  statusOutcome: DispatchOutcome | undefined;
  /** Success side-effects. A returned `DispatchOutcome` overrides
   *  `successOutcome` (e.g. a follow-on abort-loop pause commit); a void return
   *  (side-effects only) falls through to `successOutcome`. */
  // biome-ignore lint/suspicious/noConfusingVoidType: the callback may return an outcome or nothing
  onSuccess?: () => DispatchOutcome | void | Promise<DispatchOutcome | void>;
  /** Fires the instant a commit fails, before classifying occ vs status. */
  onFail?: () => void | Promise<void>;
  /** Fires before any non-halting exit (status-continue or occ-not-halted). */
  onNonHalt?: () => void | Promise<void>;
  /** Park/clear hook: called with the facts on a non-halted OCC conflict, and
   *  with undefined when the park is cleared (commit landed / status / halted). */
  onPark?: (facts: FactEvent[] | undefined) => void;
}

export function commitWithOcc(
  plan: OccCommitPlan & { successOutcome: DispatchOutcome; statusOutcome: DispatchOutcome },
  facts: FactEvent[],
): Promise<DispatchOutcome>;
export function commitWithOcc(plan: OccCommitPlan, facts: FactEvent[]): Promise<DispatchOutcome | undefined>;
export async function commitWithOcc(plan: OccCommitPlan, facts: FactEvent[]): Promise<DispatchOutcome | undefined> {
  const res = await plan.commit(facts);
  if (res.ok) {
    const override = (await plan.onSuccess?.()) as DispatchOutcome | undefined;
    plan.onPark?.(undefined);
    return override ?? plan.successOutcome;
  }
  await plan.onFail?.();
  if (res.reason === "occ") {
    const { halted } = await plan.occ.onConflict(
      plan.attemptedFactType ?? facts[0]?.type ?? "fact.unknown",
      plan.nodeId,
      plan.iteration,
      plan.expectedVersion,
    );
    if (halted) {
      plan.onPark?.(undefined);
      return { kind: "terminal" };
    }
    await plan.onNonHalt?.();
    plan.onPark?.(facts);
    return { kind: "continue" };
  }
  await plan.onNonHalt?.();
  plan.onPark?.(undefined);
  return plan.statusOutcome;
}

/** The linear path's commit primitive: any `ConcurrencyError` is an OCC conflict
 * — the linear arms never re-read to tell a status-stop apart, they always feed
 * the conflict controller (behaviour-preserving vs the pre-`commitWithOcc`
 * arms). The fan-out path passes its serialized `commitFanoutFact` instead,
 * which does make that distinction. */
export function occAppendOnce(
  store: IEventWriter & IEventReader,
  runId: string,
  expectedVersion: number,
  appendOpts?: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number },
): (facts: FactEvent[]) => Promise<CommitResult> {
  return async (facts) =>
    (await tryAppendFact(store, runId, expectedVersion, facts, appendOpts))
      ? { ok: true }
      : { ok: false, reason: "occ" };
}

/** Commit a run-parking or terminal fact batch HONESTLY — the run never stays
 * `running` with the fact silently lost on a lost OCC race (ARCH §1.6). Thin
 * wrapper over `commitWithOcc` pinning terminal-on-success / terminal-on-status
 * semantics (the run stopped). Shared by the linear and fan-out paths so neither
 * can strand the run. */
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
  const plan: OccCommitPlan & { successOutcome: DispatchOutcome; statusOutcome: DispatchOutcome } = {
    occ,
    nodeId,
    iteration,
    expectedVersion,
    commit,
    successOutcome: { kind: "terminal" },
    statusOutcome: { kind: "terminal" },
  };
  if (onPark !== undefined) plan.onPark = onPark;
  return commitWithOcc(plan, facts);
}
