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

import {
  ClaimLostError,
  ConcurrencyError,
  type FactEvent,
  type IEventReader,
  type IEventWriter,
  type RunState,
} from "@fragua/store";
import { sleep } from "./executor-helpers.ts";
import { planOccExhausted } from "./lifecycle-planner.ts";
import { spendFactsFor } from "./result-to-facts.ts";

/**
 * Outcome of a single dispatch turn. `dispatchOne` (and `commitParkOrTerminal`)
 * return this so the outer loop can decide whether to continue iterating or exit
 * (the run reached a terminal / paused state, or another short-circuit).
 */
export type DispatchOutcome = { kind: "terminal" } | { kind: "continue" };

/** Outcome of a serialized commit. A tagged `false`: `occ` is a genuine OCC
 * conflict (feed the conflict controller), `status` is the run leaving `running`
 * under us (already parked — don't), `claim_lost` is the run having been
 * requeued or re-claimed since this fiber claimed it (it is another fiber's —
 * exit without writing). */
export type CommitResult = { ok: true } | { ok: false; reason: "occ" | "status" | "claim_lost" };

/** Classify a fact append: lands → ok, `ClaimLostError` → claim_lost, any other
 * `ConcurrencyError` → occ. Non-OCC errors propagate. */
export function appendCommit(
  store: IEventWriter,
  runId: string,
  expectedVersion: number,
  facts: FactEvent[],
  opts?: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number },
): CommitResult {
  if (facts.length === 0) return { ok: true };
  try {
    store.appendFact(runId, facts, expectedVersion, opts);
    return { ok: true };
  } catch (err) {
    if (err instanceof ClaimLostError) return { ok: false, reason: "claim_lost" };
    if (err instanceof ConcurrencyError) return { ok: false, reason: "occ" };
    throw err;
  }
}

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

/** `halted`: the run left `running` (the `occ_exhausted` halt landed, or a
 * concurrent writer stopped it, or the claim moved to another fiber).
 * `abandoned`: the ceiling was hit but every halt append lost too — the run is
 * still `running` and this fiber must give its claim back (`releaseClaim`). */
export type ConflictOutcome = { halted: true } | { halted: false; abandoned?: true };

export interface OccController {
  /** Record an OCC conflict on an append. Backs off; warns once at
   * OCC_WARN_AT; at OCC_CEILING tries to halt the run (`occ_exhausted`, led by
   * `spend` — the losing batch's spend facts) and returns `{ halted: true }`
   * only once the run really left `running`, else
   * `{ halted: false, abandoned: true }`. Below the ceiling returns
   * `{ halted: false }` — the caller should re-read state and retry the turn. */
  onConflict(
    attemptedFactType: string,
    nodeId: string,
    iteration: number,
    lastVersion: number,
    spend?: readonly FactEvent[],
  ): Promise<ConflictOutcome>;
  /** Record that an append landed. Emits `occ_conflict_resolved` if there
   * were prior conflicts this turn, then resets the counter. */
  onResolved(nodeId: string, iteration: number): void;
  /** Sticky: some conflict ended `abandoned` during this `runOne` pass. */
  wasAbandoned(): boolean;
  /** Mark a fact batch as mid-commit; returns the token `releaseSpend` takes
   * once the batch's fate is known (landed, or its spend committed elsewhere). */
  holdSpend(facts: readonly FactEvent[]): number;
  releaseSpend(token: number): void;
  /** The spend of every batch still mid-commit — what a crash halt must carry
   * so an interrupted commit's spend is not lost. */
  pendingSpend(): FactEvent[];
  /** Commit `spend` alone against fresh state, bounded by
   * HALT_APPEND_MAX_ATTEMPTS — the spend of a result whose commit could not be
   * re-planned, so it lands without re-running the handler. */
  commitSpend(spend: readonly FactEvent[]): Promise<void>;
}

export function makeOccController(deps: {
  store: IEventWriter & IEventReader;
  runId: string;
  shutdownSignal: AbortSignal;
}): OccController {
  const { store, runId, shutdownSignal } = deps;
  let occCount = 0;
  let occWarned = false;
  let abandoned = false;
  let nextToken = 0;
  const held = new Map<number, readonly FactEvent[]>();

  return {
    onConflict: async (attemptedFactType, nodeId, iteration, lastVersion, spend = []) => {
      occCount++;
      if (occCount >= OCC_CEILING) {
        // The occ_exhausted halt is itself a fact append and can itself
        // conflict (the same wedged-supervisor that produced the upstream
        // conflicts may still be committing). Retry it against fresh state a
        // bounded number of times; if it never lands the run is still
        // `running`, so report `abandoned` and let runOne give the claim back
        // rather than exit with no fiber driving the run.
        for (let attempt = 0; attempt < HALT_APPEND_MAX_ATTEMPTS; attempt++) {
          const fresh = store.getState(runId);
          if (fresh == null || fresh.status !== "running") return { halted: true };
          const res = appendCommit(
            store,
            runId,
            fresh.version,
            planOccExhausted({ count: occCount, nodeId, iteration, lastVersion, attemptedFactType, spend }).facts,
          );
          if (res.ok || res.reason === "claim_lost") return { halted: true };
          await sleep(Math.min(2 ** attempt, OCC_BACKOFF_CAP_MS), shutdownSignal);
        }
        const fresh = store.getState(runId);
        if (fresh == null || fresh.status !== "running") return { halted: true };
        abandoned = true;
        return { halted: false, abandoned: true };
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
    wasAbandoned: () => abandoned,
    holdSpend: (facts) => {
      const token = nextToken++;
      held.set(token, facts);
      return token;
    },
    releaseSpend: (token) => {
      held.delete(token);
    },
    pendingSpend: () => spendFactsFor([...held.values()].flat(), "crash"),
    commitSpend: async (spend) => {
      if (spend.length === 0) return;
      for (let attempt = 0; attempt < HALT_APPEND_MAX_ATTEMPTS; attempt++) {
        const fresh = store.getState(runId);
        if (fresh == null) return;
        const res = appendCommit(store, runId, fresh.version, [...spend]);
        if (res.ok || res.reason === "claim_lost") return;
        await sleep(Math.min(2 ** attempt, OCC_BACKOFF_CAP_MS), shutdownSignal);
      }
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
  /** Success side-effects, given the facts that landed (a re-plan may have
   *  replaced the first batch). A returned `DispatchOutcome` overrides
   *  `successOutcome` (e.g. a follow-on abort-loop pause commit); a void return
   *  (side-effects only) falls through to `successOutcome`. */
  // biome-ignore lint/suspicious/noConfusingVoidType: the callback may return an outcome or nothing
  onSuccess?: (landed: FactEvent[]) => DispatchOutcome | void | Promise<DispatchOutcome | void>;
  /** Fires the instant a commit fails, before classifying occ vs status. */
  onFail?: () => void | Promise<void>;
  /** Fires before any non-halting exit (status-continue or occ-not-halted). */
  onNonHalt?: () => void | Promise<void>;
  /** Park/clear hook: called with the facts on a non-halted OCC conflict, and
   *  with undefined when the park is cleared (commit landed / status / halted). */
  onPark?: (facts: FactEvent[] | undefined) => void;
  /** Re-plan the SAME handler result against fresh state after a version-only
   *  conflict, so the commit is retried in this turn instead of re-dispatching
   *  the handler. Undefined keeps the park-and-continue behaviour. Returning
   *  undefined from the hook (the fresh state no longer fits the plan) parks. */
  replan?: (fresh: RunState) => OccReplan | undefined;
  /** Fresh-state reader the re-plan loop consults; required with `replan`. */
  readState?: () => RunState | null;
}

/** One re-planned attempt: the facts, the version they were planned against,
 * and the commit primitive bound to that version. */
export interface OccReplan {
  facts: FactEvent[];
  expectedVersion: number;
  commit: (facts: FactEvent[]) => Promise<CommitResult>;
}

export function commitWithOcc(
  plan: OccCommitPlan & { successOutcome: DispatchOutcome; statusOutcome: DispatchOutcome },
  facts: FactEvent[],
): Promise<DispatchOutcome>;
export function commitWithOcc(plan: OccCommitPlan, facts: FactEvent[]): Promise<DispatchOutcome | undefined>;
export async function commitWithOcc(plan: OccCommitPlan, facts: FactEvent[]): Promise<DispatchOutcome | undefined> {
  let attempt: OccReplan = { facts, expectedVersion: plan.expectedVersion, commit: plan.commit };
  let replanned = false;
  for (;;) {
    const token = plan.occ.holdSpend(attempt.facts);
    const res = await attempt.commit(attempt.facts);
    if (res.ok || res.reason !== "occ") plan.occ.releaseSpend(token);
    if (res.ok) {
      if (replanned) plan.occ.onResolved(plan.nodeId, plan.iteration);
      const override = (await plan.onSuccess?.(attempt.facts)) as DispatchOutcome | undefined;
      plan.onPark?.(undefined);
      return override ?? plan.successOutcome;
    }
    await plan.onFail?.();
    if (res.reason === "claim_lost") {
      await plan.onNonHalt?.();
      plan.onPark?.(undefined);
      return { kind: "terminal" };
    }
    if (res.reason !== "occ") break;
    const conflict = await plan.occ.onConflict(
      plan.attemptedFactType ?? attempt.facts[0]?.type ?? "fact.unknown",
      plan.nodeId,
      plan.iteration,
      attempt.expectedVersion,
      spendFactsFor(attempt.facts, "occ_exhausted"),
    );
    plan.occ.releaseSpend(token);
    if (conflict.halted) {
      plan.onPark?.(undefined);
      return { kind: "terminal" };
    }
    if (conflict.abandoned === true) {
      await plan.onNonHalt?.();
      plan.onPark?.(undefined);
      return { kind: "terminal" };
    }
    const next = nextReplan(plan);
    if (next === "status") break;
    if (next === undefined) return parkUnplanned(plan, attempt.facts);
    attempt = next;
    replanned = true;
  }
  await plan.onNonHalt?.();
  plan.onPark?.(undefined);
  return plan.statusOutcome;
}

/** A conflicted batch with no in-turn re-plan: a parking lane (`onPark`) keeps
 * the whole batch for re-commit next turn; without one the batch is dropped, so
 * its spend commits on its own first — the handler result is never re-run to
 * recover it. */
async function parkUnplanned(plan: OccCommitPlan, facts: FactEvent[]): Promise<DispatchOutcome> {
  await plan.onNonHalt?.();
  if (plan.onPark !== undefined) plan.onPark(facts);
  else await plan.occ.commitSpend(spendFactsFor(facts, "occ_replan_declined"));
  return { kind: "continue" };
}

/** The re-plan for the next attempt: `status` when the run left `running` under
 * us, undefined when the plan has no re-plan (or the hook declined). */
function nextReplan(plan: OccCommitPlan): OccReplan | "status" | undefined {
  if (plan.replan === undefined || plan.readState === undefined) return undefined;
  const fresh = plan.readState();
  if (fresh == null || fresh.status !== "running") return "status";
  return plan.replan(fresh);
}

/** The linear path's commit primitive: a `ConcurrencyError` is an OCC conflict
 * — the linear arms never re-read to tell a status-stop apart, they always feed
 * the conflict controller — except a `ClaimLostError`, which ends the fiber.
 * The fan-out path passes its serialized `commitFanoutFact` instead, which also
 * tells a status-stop apart. */
export function occAppendOnce(
  store: IEventWriter & IEventReader,
  runId: string,
  expectedVersion: number,
  appendOpts?: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number },
): (facts: FactEvent[]) => Promise<CommitResult> {
  return async (facts) => appendCommit(store, runId, expectedVersion, facts, appendOpts);
}

/** Commit a run-parking or terminal fact batch HONESTLY — the run never stays
 * `running` with the fact silently lost on a lost OCC race (ARCH §1.6). Thin
 * wrapper over `commitWithOcc` pinning terminal-on-success / terminal-on-status
 * semantics (the run stopped). With the default commit a version-only conflict
 * re-commits the same batch against the fresh version in this call (bounded by
 * the controller's ceiling); a caller-supplied commit (the fan-out lane) keeps
 * park-and-continue. Shared by the linear and fan-out paths so neither can
 * strand the run. */
export async function commitParkOrTerminal(deps: ParkOrTerminalDeps, facts: FactEvent[]): Promise<DispatchOutcome> {
  const { store, runId, occ, nodeId, iteration, expectedVersion, onPark } = deps;
  const defaultCommit =
    (version: number) =>
    async (f: FactEvent[]): Promise<CommitResult> => {
      const res = appendCommit(store, runId, version, f, deps.appendOpts);
      if (res.ok || res.reason === "claim_lost") return res;
      const fresh = store.getState(runId);
      if (fresh == null || fresh.status !== "running") return { ok: false, reason: "status" };
      return { ok: false, reason: "occ" };
    };
  const plan: OccCommitPlan & { successOutcome: DispatchOutcome; statusOutcome: DispatchOutcome } = {
    occ,
    nodeId,
    iteration,
    expectedVersion,
    commit: deps.commit ?? defaultCommit(expectedVersion),
    successOutcome: { kind: "terminal" },
    statusOutcome: { kind: "terminal" },
  };
  if (deps.commit === undefined) {
    plan.readState = () => store.getState(runId);
    plan.replan = (fresh) => ({ facts, expectedVersion: fresh.version, commit: defaultCommit(fresh.version) });
  }
  if (onPark !== undefined) plan.onPark = onPark;
  return commitWithOcc(plan, facts);
}
