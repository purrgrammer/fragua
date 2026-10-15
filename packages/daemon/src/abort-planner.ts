// Pure exit planner — the sibling of `transition-planner.ts` (the success arm).
// Every non-success handler exit on BOTH dispatch paths (linear and fan-out
// branch) is classified here: a thrown error, a watchdog timeout, an operator /
// steer abort, a daemon shutdown, a leaked handler, or a reactive-budget trip.
// Given the exit, decide the fact batch + routing patch + a control outcome. No
// store, clock, RNG, or I/O — `now` and `leakedAt` are values.
//
// Every plan leads with `fact.node_aborted` carrying the turn's spend (the one
// producer is `exitSpendFacts`), so a run-parking or terminal fact never has to
// carry spend and the fan-out disposition slot can drop a losing halt without
// losing money from run totals.
//
// The driver keeps the effectful sequencing: the abort-loop ceiling is a SECOND
// commit after the streak bump, and the timeout-retry commit re-drives on an OCC
// conflict. So `planExit` returns an `outcome` tag the driver switches on.

import { AUTO_RESUME_AT_KEY, getRetry, readGoalGateRetries, timeoutRetriesKey } from "@fragua/core";
import type { FactEvent } from "@fragua/store";
import { exitSpendFacts, type HaltUsage } from "./result-to-facts.ts";
import { computeAdvanceAppliedTo, type PlannedObservability } from "./transition-planner.ts";

// Watchdog timeout-retry policy (system-initiated, NOT workflow-initiated — so
// it doesn't bump the abort streak). Per-node attempt counter lives at
// `routing.internal.timeout_retries.<nodeId>`.
const TIMEOUT_RETRY_BACKOFF_MS_BASE = 5_000;
const TIMEOUT_RETRY_BACKOFF_MS_CEILING = 60_000;
const TIMEOUT_RETRY_MAX_ATTEMPTS = 3;

/** How a handler dispatch ended without returning a result. */
export type ExitKind = "throw" | "timeout" | "abort" | "shutdown" | "leak";

/** The `fact.node_aborted.cause` each exit records. */
const EXIT_CAUSE: Record<ExitKind, string> = {
  throw: "error",
  timeout: "timeout",
  abort: "aborted",
  shutdown: "shutdown",
  leak: "leak",
};

export interface BudgetBreach {
  scope: "run" | "node";
  metric: "cost" | "tokens";
  limit: number;
  actual: number;
}

export interface ExitClassifyInput {
  invocation: "leak" | "thrown";
  /** The thrown error is named AbortError / TimeoutError. */
  abortByName: boolean;
  /** The dispatch's composed signal had tripped when the handler threw. */
  signalAborted: boolean;
  /** The daemon's shutdown signal had tripped. */
  shutdownAborted: boolean;
  /** `classifyAbortCause` over the composed signal + error. */
  abortCause: "timeout" | "aborted";
  /** The linear reactive budget gate tripped the steer controller. */
  budgetTripped: boolean;
}

/** Classify a non-result invocation. A throw while the dispatch's signal had
 * tripped is an abort even when the handler wrapped the AbortError. */
export function classifyExit(input: ExitClassifyInput): ExitKind {
  if (input.invocation === "leak") return "leak";
  const aborted = input.abortByName || input.signalAborted || input.budgetTripped;
  if (!aborted) return "throw";
  if (input.abortCause === "timeout") return "timeout";
  if (input.shutdownAborted) return "shutdown";
  return "abort";
}

export interface ExitPlanInput {
  exit: ExitKind;
  currentNode: string;
  iteration: number;
  /** The thrown error's message (→ the `throw` halt's detail). */
  errorDetail?: string;
  /** Wall-clock value at leak detection (→ `fact.handler_timeout_leaked`). */
  leakedAt?: number;
  /** Set when the reactive budget gate tripped a stop-policy breach mid-handler
   * → halt with `reason:"budget"`. The string is the optional halt detail. */
  reactiveBudgetHaltDetail: string | undefined;
  /** Set when the reactive budget gate tripped a pause-policy breach → pause
   * with `reason:"budget"` so the operator can raise the cap + resume. */
  reactiveBudgetPauseBreach: BudgetBreach | undefined;
  /** The dispatch's usage totals — always credited onto `fact.node_aborted`. */
  usage: HaltUsage;
  /** This turn's intent-fold delta + applied seqs — merged into the commit so
   * operator intents queued for the dying dispatch aren't lost. */
  routingDelta: Record<string, unknown>;
  appliedSeqs: readonly number[];
  /** Run routing (reads the per-node timeout-retry counter + pass). */
  effectiveRouting: Readonly<Record<string, unknown>>;
  /** Wall-clock value (driver passes `clock()`), for `resumeAt`. */
  now: number;
  /** The deadline the dispatch armed (→ `attemptedMs` on a timeout pause). */
  attemptedMs: number;
}

/**
 * - `halt`          — commit facts (incl. a terminal `run_terminated{errored}`), run is done.
 * - `pause`         — commit facts (incl. `run_paused`), run releases its slot.
 * - `timeout_retry` — commit facts + routing patch; on OCC conflict, re-drive.
 * - `abort_step`    — commit `node_aborted` only; the driver then bumps the
 *                     abort streak and applies the abort-loop ceiling.
 * - `shutdown`      — commit `node_aborted` only; no streak bump, the turn ends
 *                     and the still-`running` run is requeued on restart.
 */
export type ExitOutcome = "halt" | "pause" | "timeout_retry" | "abort_step" | "shutdown";

export interface ExitPlan {
  facts: FactEvent[];
  routingPatch?: Record<string, unknown>;
  advanceAppliedTo?: number;
  outcome: ExitOutcome;
}

/** The single budget-breach fact producer: a stop-policy breach halts
 * (`run_terminated{budget}`), a pause-policy breach parks (`run_paused{budget}`),
 * neither is undefined. Halt wins when both are set. */
export function planBudgetBreach(
  breach: { haltDetail?: string | undefined; pauseBreach?: BudgetBreach | undefined },
  nodeId: string,
): FactEvent | undefined {
  if (breach.haltDetail !== undefined) {
    const payload: { status: "errored"; reason: "budget"; detail?: string } = { status: "errored", reason: "budget" };
    if (breach.haltDetail.length > 0) payload.detail = breach.haltDetail;
    return { type: "fact.run_terminated", payload };
  }
  if (breach.pauseBreach !== undefined) {
    const b = breach.pauseBreach;
    return {
      type: "fact.run_paused",
      payload: { reason: "budget", nodeId, scope: b.scope, metric: b.metric, limit: b.limit, actual: b.actual },
    };
  }
  return undefined;
}

/** Decide the exit commit. Pure: same input ⇒ same plan, no mutation.
 * Precedence: leak > reactive budget halt / pause > shutdown > timeout > throw >
 * abort. A leaked handler is still running, so nothing may let the run resume. */
export function planExit(input: ExitPlanInput): ExitPlan {
  const { currentNode, iteration, exit, usage, routingDelta, appliedSeqs } = input;

  const facts = exitSpendFacts(
    currentNode,
    iteration,
    EXIT_CAUSE[exit],
    usage,
    readGoalGateRetries(input.effectiveRouting),
  );

  const baseAdvance = computeAdvanceAppliedTo(appliedSeqs);
  const baseRoutingPatch = Object.keys(routingDelta).length > 0 ? { ...routingDelta } : undefined;
  const withBase = (outcome: ExitOutcome): ExitPlan => ({
    facts,
    outcome,
    ...(baseRoutingPatch !== undefined ? { routingPatch: baseRoutingPatch } : {}),
    ...(baseAdvance !== undefined ? { advanceAppliedTo: baseAdvance } : {}),
  });

  if (exit === "leak") {
    facts.push(
      { type: "fact.handler_timeout_leaked", payload: { nodeId: currentNode, leakedAt: input.leakedAt ?? input.now } },
      { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
    );
    return withBase("halt");
  }

  const breach = planBudgetBreach(
    { haltDetail: input.reactiveBudgetHaltDetail, pauseBreach: input.reactiveBudgetPauseBreach },
    currentNode,
  );
  if (breach !== undefined) {
    facts.push(breach);
    return withBase(breach.type === "fact.run_terminated" ? "halt" : "pause");
  }

  if (exit === "shutdown") return withBase("shutdown");

  if (exit === "timeout") {
    const priorAttempts = getRetry(input.effectiveRouting).timeoutRetries(currentNode);
    const nextAttempt = priorAttempts + 1;
    if (nextAttempt < TIMEOUT_RETRY_MAX_ATTEMPTS) {
      const delayMs = Math.min(TIMEOUT_RETRY_BACKOFF_MS_CEILING, TIMEOUT_RETRY_BACKOFF_MS_BASE * 2 ** priorAttempts);
      const resumeAt = input.now + delayMs;
      facts.push({
        type: "fact.run_paused",
        payload: {
          reason: "timeout_retry",
          nodeId: currentNode,
          attempt: nextAttempt,
          delayMs,
          resumeAt,
          maxAttempts: TIMEOUT_RETRY_MAX_ATTEMPTS,
          attemptedMs: input.attemptedMs,
        },
      });
      return {
        facts,
        outcome: "timeout_retry",
        routingPatch: {
          ...routingDelta,
          [AUTO_RESUME_AT_KEY]: resumeAt,
          [timeoutRetriesKey(currentNode)]: nextAttempt,
        },
        ...(baseAdvance !== undefined ? { advanceAppliedTo: baseAdvance } : {}),
      };
    }
    facts.push({
      type: "fact.run_terminated",
      payload: {
        status: "errored",
        reason: "timeout_exhausted",
        detail: `${TIMEOUT_RETRY_MAX_ATTEMPTS} watchdog timeouts on node "${currentNode}"; thread continuity preserved but progress stalled`,
      },
    });
    return withBase("halt");
  }

  if (exit === "throw") {
    const payload: { status: "errored"; reason: "error"; detail?: string } = { status: "errored", reason: "error" };
    if (input.errorDetail !== undefined && input.errorDetail.length > 0) payload.detail = input.errorDetail;
    facts.push({ type: "fact.run_terminated", payload });
    return withBase("halt");
  }

  return withBase("abort_step");
}

export interface AbortLoopInput {
  /** The consecutive-abort streak AFTER the driver bumped it. */
  consecutiveAborts: number;
  /** The abort-loop ceiling (`abortLoopCeiling`). */
  ceiling: number;
  /** The node the streak is running on (for the warn / pause payload). */
  nodeId: string;
}

export interface AbortLoopPlan {
  /** A one-shot trend warning emitted the abort BEFORE the ceiling. */
  warn?: PlannedObservability;
  /** The recoverable `abort_loop` pause once the streak hits the ceiling. */
  pause?: FactEvent;
}

/** Decide the abort-loop trend warning / ceiling pause for a plain workflow or
 * operator abort. Pure: the driver owns the counter bump (before this call) and
 * the two-commit sequencing (`node_aborted` first, then the pause against a
 * re-read version). The warn fires exactly one abort before the ceiling; the
 * pause fires at or past it — the two are mutually exclusive per call. */
export function planAbortLoop(input: AbortLoopInput): AbortLoopPlan {
  const { consecutiveAborts, ceiling, nodeId } = input;
  const plan: AbortLoopPlan = {};
  if (consecutiveAborts === ceiling - 1) {
    plan.warn = { type: "abort_loop_warning", payload: { nodeId, consecutiveAborts, ceiling } };
  }
  if (consecutiveAborts >= ceiling) {
    plan.pause = {
      type: "fact.run_paused",
      payload: { reason: "abort_loop", nodeId, consecutiveAborts },
    };
  }
  return plan;
}

/** `planAbortLoop` over every fan-out branch streak: each branch's trend
 * warning, and the first branch at or past the ceiling as the pause. */
export function planAbortLoops(
  streaks: ReadonlyMap<string, number>,
  ceiling: number,
): { warns: PlannedObservability[]; pause?: FactEvent } {
  const warns: PlannedObservability[] = [];
  let pause: FactEvent | undefined;
  for (const [nodeId, consecutiveAborts] of streaks) {
    const plan = planAbortLoop({ consecutiveAborts, ceiling, nodeId });
    if (plan.warn !== undefined) warns.push(plan.warn);
    if (pause === undefined && plan.pause !== undefined) pause = plan.pause;
  }
  return pause !== undefined ? { warns, pause } : { warns };
}
