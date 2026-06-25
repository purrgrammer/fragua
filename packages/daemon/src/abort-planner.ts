// Pure planner for the post-handler ABORT arm — the sibling of
// `transition-planner.ts` (the success arm). Given a turn that ended in an
// abort (handler threw an AbortError, a watchdog timeout fired, or the
// reactive budget gate tripped mid-handler), decide the fact batch + routing
// patch + a control outcome. No store, clock, RNG, or I/O — `now` is a value.
//
// The executor keeps the effectful sequencing the abort arm needs and the
// success arm doesn't: the abort-loop ceiling is a SECOND commit after a
// re-read of the version (it depends on the bumped `consecutiveAborts`), and
// the timeout-retry commit re-drives on an OCC conflict. So `planAbort`
// returns an `outcome` tag the executor switches on, rather than committing.

import { AUTO_RESUME_AT_KEY, readGoalGateRetries } from "@fragua/core";
import type { FactEvent } from "@fragua/store";
import { readNumber, type UsageTotals } from "./executor-helpers.ts";
import { abortResultToFacts } from "./result-to-facts.ts";
import { computeAdvanceAppliedTo } from "./transition-planner.ts";

// Watchdog timeout-retry policy (system-initiated, NOT workflow-initiated — so
// it doesn't bump `consecutiveAborts`). Per-node attempt counter lives at
// `routing.internal.timeout_retries.<nodeId>`.
const TIMEOUT_RETRY_BACKOFF_MS_BASE = 5_000;
const TIMEOUT_RETRY_BACKOFF_MS_CEILING = 60_000;
const TIMEOUT_RETRY_MAX_ATTEMPTS = 3;

const timeoutRetryKey = (nodeId: string): string => `internal.timeout_retries.${nodeId}`;

export interface AbortPlanInput {
  currentNode: string;
  iteration: number;
  /** `classifyAbortCause` result: "timeout" routes to watchdog-retry, anything
   * else is a workflow/operator abort. */
  abortCause: string;
  /** Set when the reactive budget gate tripped a stop-policy breach mid-handler
   * → halt with `reason:"budget"`. The string is the optional halt detail. */
  reactiveBudgetHaltDetail: string | undefined;
  /** Set when the reactive budget gate tripped a pause-policy breach → pause
   * with `reason:"budget"` so the operator can raise the cap + resume. */
  reactiveBudgetPauseBreach:
    | { scope: "run" | "node"; metric: "cost" | "tokens"; limit: number; actual: number }
    | undefined;
  /** Partial spend to credit onto `fact.node_aborted` — the dispatch's usage
   * totals, taken directly from the shared accumulator (one shape end to end;
   * a translation bridge here drifted once before it was deleted). */
  usage: UsageTotals;
  /** This turn's intent-fold delta + applied seqs — merged into the abort
   * commit so operator intents queued for the dying dispatch aren't lost. */
  routingDelta: Record<string, unknown>;
  appliedSeqs: readonly number[];
  /** Run routing (reads the per-node timeout-retry counter). */
  effectiveRouting: Record<string, unknown>;
  /** Wall-clock value (executor passes `clock()`), for `resumeAt`. */
  now: number;
  /** The node's configured `maxMs` (→ `attemptedMs` on a timeout pause). */
  attemptedMs: number;
}

/**
 * - `halt`         — commit facts (incl. a terminal `run_terminated{status:errored}`), run is done.
 * - `pause`        — commit facts (incl. `run_paused`), run releases its slot.
 * - `timeout_retry`— commit facts + routing patch; on OCC conflict, re-drive.
 * - `abort_step`   — commit `node_aborted` only; executor then bumps
 *                    `consecutiveAborts` and applies the abort-loop ceiling.
 */
export type AbortOutcome = "halt" | "pause" | "timeout_retry" | "abort_step";

export interface AbortPlan {
  facts: FactEvent[];
  routingPatch?: Record<string, unknown>;
  advanceAppliedTo?: number;
  outcome: AbortOutcome;
}

/** Decide the abort commit. Pure: same input ⇒ same plan, no mutation. */
export function planAbort(input: AbortPlanInput): AbortPlan {
  const { currentNode, iteration, abortCause, usage, routingDelta, appliedSeqs } = input;

  // Base: fact.node_aborted carrying this turn's partial spend.
  const facts = abortResultToFacts(
    currentNode,
    iteration,
    abortCause,
    usage,
    readGoalGateRetries(input.effectiveRouting),
  );

  // Carry this turn's fold (routing delta + applied seqs) onto the commit so a
  // queued operator intent isn't left unapplied for the next dispatch to re-fold.
  const baseAdvance = computeAdvanceAppliedTo(appliedSeqs);
  const baseRoutingPatch = Object.keys(routingDelta).length > 0 ? routingDelta : undefined;
  const withBase = (outcome: AbortOutcome): AbortPlan => ({
    facts,
    outcome,
    ...(baseRoutingPatch !== undefined ? { routingPatch: baseRoutingPatch } : {}),
    ...(baseAdvance !== undefined ? { advanceAppliedTo: baseAdvance } : {}),
  });

  // 1. Reactive-budget stop-policy breach → terminal halt alongside the abort.
  if (input.reactiveBudgetHaltDetail !== undefined) {
    const haltPayload: { status: "errored"; reason: "budget"; detail?: string } = {
      status: "errored",
      reason: "budget",
    };
    if (input.reactiveBudgetHaltDetail.length > 0) haltPayload.detail = input.reactiveBudgetHaltDetail;
    facts.push({ type: "fact.run_terminated", payload: haltPayload });
    return withBase("halt");
  }

  // 2. Reactive-budget pause-policy breach → recoverable pause. Not an
  //    abort-loop bump (system-initiated).
  if (input.reactiveBudgetPauseBreach !== undefined) {
    const b = input.reactiveBudgetPauseBreach;
    facts.push({
      type: "fact.run_paused",
      payload: {
        reason: "budget",
        nodeId: currentNode,
        scope: b.scope,
        metric: b.metric,
        limit: b.limit,
        actual: b.actual,
      },
    });
    return withBase("pause");
  }

  // 3. Watchdog timeout → system-initiated retry (or exhaustion). NOT an
  //    abort-loop bump. Bounded per node by the routing counter.
  if (abortCause === "timeout") {
    const counterKey = timeoutRetryKey(currentNode);
    const priorAttempts = readNumber(input.effectiveRouting[counterKey]);
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
      const routingPatch: Record<string, unknown> = {
        ...routingDelta,
        [AUTO_RESUME_AT_KEY]: resumeAt,
        [counterKey]: nextAttempt,
      };
      return {
        facts,
        outcome: "timeout_retry",
        routingPatch,
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

  // 4. Plain workflow/operator abort → just node_aborted. The executor bumps
  //    consecutiveAborts and applies the abort-loop ceiling (a second commit).
  return withBase("abort_step");
}
