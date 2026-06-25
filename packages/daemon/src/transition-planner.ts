// Pure transition planner — executor-pbt-decomposition.md Phase 4.
//
// Given a successful (non-abort) handler turn's inputs, decide what comes out:
// the facts to commit, the routing patch, the applied-seq advance, and the
// observability trail — with no store reads, no clock, no RNG, no I/O. The
// executor keeps the commit (`tryAppendFact`), OCC retry, and snapshot; this
// owns the decision. Pure ⇒ every fact-list-rewrite invariant
// (exactly-one-terminal, node_completed preserved under budget halt, retry
// pause swaps node_started, …) becomes a property over generated input.

import {
  AUTO_RESUME_AT_KEY,
  checkGoalGates,
  type EdgeSelection,
  evaluateBudget,
  GOAL_GATE_RETRIES_KEY,
  type Graph,
  getLimits,
  getRetry,
  goalGateOutcomeKey,
  goalGateStep,
  readGateOutcomes,
  readGoalGateRetries,
  resolveFailRetarget,
  retryCountKey,
  retryStep,
  selectEdge,
} from "@fragua/core";
import type { HandlerResult, IntentDecision } from "@fragua/core/handler";
import type { FactEvent, RunState } from "@fragua/store";
import {
  BUDGET_WARNED_KEY,
  mergeRoutingPatches,
  readBudgetOverrides,
  readBudgetWarned,
  readNumber,
  recordEdgeSelected,
  resolveBackoff,
  resolveMaxRetries,
} from "./executor-helpers.ts";
import {
  decideProviderRetry,
  PROVIDER_RETRY_ATTEMPT_KEY,
  PROVIDER_RETRY_CUMULATIVE_MS_KEY,
  type ProviderRetryDecision,
} from "./provider-retry-policy.ts";
import { resultToFacts } from "./result-to-facts.ts";

/** One observability event the planner decided to emit. The executor drains
 * these into the run's observability buffer (then `flushObservability`)
 * before committing the facts, preserving the trail→terminal-fact order. */
export interface PlannedObservability {
  type: string;
  payload: Record<string, unknown>;
}

/** This turn's LLM accounting, accumulated by the executor across the
 * handler's `cost.recorded` mirror. Folded into `fact.node_completed` when
 * the handler didn't report its own split. */
export interface TurnAccounting {
  turnBilled: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Per-bucket cost splits from the `cost.recorded` mirror. Optional —
   * the `ctx.llm.call` accounting lane has no bucket-cost source. Carried
   * onto `fact.run_terminated{errored}.partial*CostUsd` when a structural halt drops
   * the turn (see ResultContext.usage in result-to-facts). */
  totalInputCostUsd?: number;
  totalOutputCostUsd?: number;
  totalCacheReadCostUsd?: number;
  totalCacheWriteCostUsd?: number;
  lastModel: string | undefined;
}

export interface TransitionInput {
  /** Pre-handler run projection (metrics, routing, currentNode, workflowSha). */
  state: RunState;
  /** This turn's intent fold. The proceed variant only — cancel and
   * immediate-pause return before the handler dispatches. */
  decision: Extract<IntentDecision, { kind: "proceed" }>;
  /** Resolved graph for `state.workflowSha`, or null when the source
   * doesn't parse (already-running test fixtures). Matches `graphFor`. */
  graph: Graph | null;
  /** The handler's return value. Never mutated — the transition variant is
   * cloned before routing/accounting resolution. */
  handlerResult: HandlerResult;
  accounting: TurnAccounting;
  /** `state.routing` merged with this turn's fold delta — the view every
   * per-turn override reader (budget, max_retries, goal-gate) consults. */
  effectiveRouting: Readonly<Record<string, unknown>>;
  currentNode: string;
  iteration: number;
  /** Wall-clock captured once by the executor — a value, not a clock. */
  now: number;
  /** Injectable RNG for retry / provider backoff jitter. */
  random: () => number;
}

export interface TransitionPlan {
  facts: FactEvent[];
  routingPatch?: Record<string, unknown>;
  advanceAppliedTo?: number;
  observability: PlannedObservability[];
}

/** The proceed-only intent fold variant the planner operates on. */
export type ProceedDecision = Extract<IntentDecision, { kind: "proceed" }>;

/** A budget-gate breach that the executor turns into an operator-resumable
 * pause (deferred until after `resultToFacts`). */
export interface BudgetPause {
  scope: "node" | "run";
  metric: "cost" | "tokens";
  limit: number;
  actual: number;
}

/** A handler-retry backoff pause: the run sleeps without a slot until
 * `resumeAt`, then wake-pending re-dispatches the same node. */
export interface RetryPause {
  nodeId: string;
  attempt: number;
  delayMs: number;
  resumeAt: number;
  maxRetries: number;
}

/** A retry-counter exhaustion turned into an operator-resumable pause. */
export interface RetriesExhaustedPause {
  nodeId: string;
  currentLimit: number;
  attempts: number;
}

/** Stage 1 output: the resolved handler result (with accounting backfilled
 * and edge selection applied) plus the held edge selection / converted
 * usage the later stages and fact builder consume. */
export interface EdgeSelectionOutcome {
  result: HandlerResult;
  /** Held for `edge.selected`, emitted only if no goal-gate retarget fires. */
  pendingEdgeSelection?: EdgeSelection;
  /** Spend carried onto the halt fact when edge_no_match converts a
   * cost-bearing transition into a halt. */
  convertedTransitionUsage?: TurnAccounting;
}

/** Stage 1 — accounting backfill + edge selection (SPEC §3.6). Clones the
 * transition variant so the caller's handler result is never mutated; other
 * kinds flow through unchanged. Pure: `input data -> output data`. */
export function selectTransitionEdge(args: {
  handlerResult: HandlerResult;
  graph: Graph | null;
  currentNode: string;
  accounting: TurnAccounting;
}): EdgeSelectionOutcome {
  const { graph, currentNode, accounting } = args;
  const {
    turnBilled,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    lastModel,
  } = accounting;

  let result: HandlerResult = args.handlerResult.kind === "transition" ? { ...args.handlerResult } : args.handlerResult;

  let pendingEdgeSelection: EdgeSelection | undefined;
  let convertedTransitionUsage: TurnAccounting | undefined;

  // Attach LLM accounting into the node_completed fact if the handler
  // didn't set these explicitly.
  if (result.kind === "transition") {
    if (result.tokens === 0 && turnBilled > 0) result.tokens = turnBilled;
    if (result.costUsd === 0 && totalCostUsd > 0) result.costUsd = totalCostUsd;
    // Split fields: only fill from executor accounting when the handler
    // didn't already report any. Handlers that already know their own
    // split (handler-bridge aggregating cost.recorded) win — the
    // executor's LlmAccounting doesn't see llm calls that go
    // through the agent backend.
    if ((result.inputTokens ?? 0) === 0 && totalInputTokens > 0) result.inputTokens = totalInputTokens;
    if ((result.outputTokens ?? 0) === 0 && totalOutputTokens > 0) result.outputTokens = totalOutputTokens;
    if ((result.cacheReadTokens ?? 0) === 0 && totalCacheReadTokens > 0) {
      result.cacheReadTokens = totalCacheReadTokens;
    }
    if ((result.cacheWriteTokens ?? 0) === 0 && totalCacheWriteTokens > 0) {
      result.cacheWriteTokens = totalCacheWriteTokens;
    }
    if (result.modelName == null && lastModel != null) result.modelName = lastModel;

    // Edge selection: when the handler left `nextNode` unset, pick from
    // the current node's outgoing edges via the two-case selector
    // (SPEC §3.6). With it set, the handler is bypassing routing on purpose.
    if (result.nextNode == null) {
      const srcNode = graph?.nodes[currentNode];
      if (graph != null && srcNode != null) {
        const selectorOutcome: Parameters<typeof selectEdge>[0]["outcome"] = {
          status: result.outcomeStatus ?? "success",
          notes: "",
        };
        if (result.route !== undefined && result.route.length > 0) selectorOutcome.route = result.route;
        const selection = selectEdge({
          graph,
          source: srcNode,
          outcome: selectorOutcome,
        });
        if (selection != null) {
          result.nextNode = selection.edge.to;
          pendingEdgeSelection = selection;
        } else if (result.route !== undefined && result.route.length > 0) {
          // Routing node carried a chosen route but no outgoing edge
          // matched (runtime backstop for `edge_no_match`). Convert
          // into a halt so the existing `case "halt"` arm in
          // result-to-facts emits
          // `fact.run_terminated{errored,reason:"edge_no_match"}` with a
          // diagnostic detail; validator should make this
          // unreachable for a pinned graph.
          convertedTransitionUsage = {
            turnBilled: result.tokens,
            totalCostUsd: result.costUsd,
            totalInputTokens: result.inputTokens ?? 0,
            totalOutputTokens: result.outputTokens ?? 0,
            totalCacheReadTokens: result.cacheReadTokens ?? 0,
            totalCacheWriteTokens: result.cacheWriteTokens ?? 0,
            totalInputCostUsd: result.inputCostUsd ?? 0,
            totalOutputCostUsd: result.outputCostUsd ?? 0,
            totalCacheReadCostUsd: result.cacheReadCostUsd ?? 0,
            totalCacheWriteCostUsd: result.cacheWriteCostUsd ?? 0,
            lastModel: result.modelName,
          };
          result = {
            kind: "halt",
            reason: "edge_no_match",
            detail: `no edge keyed route="${result.route}" from ${currentNode}`,
          };
        } else if (result.outcomeStatus === "fail") {
          // No fail-edge claimed the failure. A goal_gate node routes
          // through the terminal so the *capped* goalGateStep below
          // applies the retarget (and bumps the cap counter) rather
          // than the unbounded resolveFailRetarget path. Non-gate
          // nodes consult §3.7 retry_target before the `__end__`
          // terminal halt.
          if (srcNode.attrs.goal_gate === true) {
            result.nextNode = "__end__";
          } else {
            const retarget = resolveFailRetarget(graph, currentNode);
            result.nextNode = retarget ?? "__end__";
          }
        } else {
          // No outgoing edges or no viable selection — terminal.
          result.nextNode = "__end__";
        }
      } else {
        // Graph unavailable (already-running test fixtures without a
        // parseable workflow) — terminal by default.
        result.nextNode = "__end__";
      }
    }
  }

  const out: EdgeSelectionOutcome = { result };
  if (pendingEdgeSelection !== undefined) out.pendingEdgeSelection = pendingEdgeSelection;
  if (convertedTransitionUsage !== undefined) out.convertedTransitionUsage = convertedTransitionUsage;
  return out;
}

/** Stage 2 output: the budget-gate events and the (deferred) pause / halt
 * sentinels the executor applies after `resultToFacts`. */
export interface BudgetGateOutcome {
  observability: PlannedObservability[];
  budgetWarnedTags: readonly string[];
  budgetPause?: BudgetPause;
  budgetHaltDetail?: string;
}

/** Stage 2 — budget enforcement at the post-handler boundary. The check sees
 * cumulative spend INCLUDING this turn (state.metrics doesn't have the new
 * fact applied yet, so we add result.{tokens,costUsd} in). On halt, the halt
 * is deferred until after resultToFacts so fact.node_completed lands first —
 * without that, the breaching turn's spend is visible to the gate but never
 * folds into run_state.total_cost_usd or nodeCosts[currentNode]; the
 * projection would lag the gate's `actual` by the breaching-turn cost. On
 * warn-only, the warn event(s) are returned and the transition continues. */
export function applyBudgetGate(args: {
  result: HandlerResult;
  graph: Graph | null;
  state: RunState;
  currentNode: string;
  iteration: number;
  effectiveRouting: Readonly<Record<string, unknown>>;
}): BudgetGateOutcome {
  const { result, graph, state, currentNode, iteration, effectiveRouting } = args;
  const observability: PlannedObservability[] = [];
  let budgetWarnedTags: readonly string[] = [];
  let budgetPause: BudgetPause | undefined;
  let budgetHaltDetail: string | undefined;
  if (result.kind === "transition") {
    const completedNodeAttrs = graph?.nodes[currentNode]?.attrs;
    const turnFresh = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
    const turnCost = result.costUsd ?? 0;
    const priorNodeBucket = state.metrics.nodeCosts[currentNode] ?? { tokens: 0, costUsd: 0 };
    const priorRunFresh = state.metrics.totalInputTokens + state.metrics.totalOutputTokens;
    const alreadyWarned = readBudgetWarned(effectiveRouting);
    const overrides = readBudgetOverrides(effectiveRouting);
    const decisionBudget = evaluateBudget({
      graphAttrs: graph?.attrs ?? {},
      ...(completedNodeAttrs !== undefined ? { completedNodeAttrs } : {}),
      completedNodeId: currentNode,
      cumulativeCostUsd: state.metrics.totalCostUsd + turnCost,
      cumulativeTokens: priorRunFresh + turnFresh,
      nodeCumulativeCostUsd: priorNodeBucket.costUsd + turnCost,
      nodeCumulativeTokens: priorNodeBucket.tokens + turnFresh,
      alreadyWarned,
      ...(overrides !== undefined ? { overrides } : {}),
    });
    for (const ev of decisionBudget.events) {
      observability.push({ type: ev.type, payload: { nodeId: currentNode, iteration, ...ev.payload } });
    }
    budgetWarnedTags = decisionBudget.newlyWarned;
    if (decisionBudget.shouldHalt) {
      budgetHaltDetail = decisionBudget.haltReason ?? "";
    } else if (decisionBudget.pauseBreach !== undefined) {
      budgetPause = decisionBudget.pauseBreach;
    }
  }
  const budgetOut: BudgetGateOutcome = { observability, budgetWarnedTags };
  if (budgetPause !== undefined) budgetOut.budgetPause = budgetPause;
  if (budgetHaltDetail !== undefined) budgetOut.budgetHaltDetail = budgetHaltDetail;
  return budgetOut;
}

/** Stage 3 output: the (possibly halt-rewritten) result plus the retarget
 * target / bumped retry counter when goalGateStep redirected. */
export interface GoalGateOutcome {
  result: HandlerResult;
  observability: PlannedObservability[];
  goalGateRetargetTarget?: string;
  goalGateRetriesPatch?: number;
}

// Goal-gate enforcement (attractor §3.4). Two responsibilities:
//   1. Record this node's outcome under `goal_gates.<id>` whenever it
//      has goal_gate=true, so terminal-arrival can read the fold.
//   2. When the resolved transition leads to a terminal, check every
//      visited gate: if any unsatisfied, redirect to the failed gate's
//      `retry_target` (bounded by max_goal_gate_retries).
//   3. Counter exhaust or unset `retry_target` → halt with
//      `goal_gate_unsatisfied`.
//
// The current-turn outcome is folded into a synthetic snapshot before
// checking gates, so a final-stage gate that just completed can be
// evaluated without waiting for the next turn's projection refresh.
//
// Carve-out: a *non-gate* node's own `outcome=fail` (abort, or any
// unrecovered failure) is the node's own decision to terminate the
// run — the §3.4 chain must not intercept it. Without this skip, an
// earlier gate's persisted `fail` in routing state would steal every
// downstream terminal: a propose-step abort after a paused/resumed
// gate would silently retarget the gate's `retry_target` (often the
// proposer itself), looping until the operator-raised cap exhausts.
// The intent at `agent/backend.ts:findAbortToolCall` is explicit —
// "an ordinary node with no fail-edge then halts (`aborted_exit`)";
// gate-driven retargeting is reserved for the gate node's *own* fail.
// The same carve-out also rescues an explicit `on: {fail: <target>}`
// route: the edge selector picked the target above, but without the
// skip the §3.4 check would rewrite `result.nextNode` back to the
// gate's `retry_target`, silently overriding the author's sanctioned
// fail-landing: an explicit edge to the `exit` sink on failure is a
// sanctioned landing — the run *completes*. One condition, both cases.
/** Stage 3 — goal-gate retarget / halt. Operates on a clone: returns a result
 * whose `nextNode` may be the retry target, or a `goal_gate_unsatisfied` halt.
 * Whether the retarget is actually consumed is decided from the FINAL result
 * in planTransition (the retry gate may override it). */
export function applyGoalGate(args: {
  result: HandlerResult;
  graph: Graph | null;
  state: RunState;
  currentNode: string;
  effectiveRouting: Readonly<Record<string, unknown>>;
}): GoalGateOutcome {
  const { graph, state, currentNode, effectiveRouting } = args;
  // Operate on a clone so this stage never mutates the caller's result —
  // the later retry gate may overwrite `nextNode`, and the slot/epoch
  // consumption is decided from the FINAL result back in planTransition.
  let result = args.result.kind === "transition" ? { ...args.result } : args.result;
  const observability: PlannedObservability[] = [];
  let goalGateRetargetTarget: string | undefined;
  let goalGateRetriesPatch: number | undefined;
  if (result.kind === "transition") {
    const completedNode = graph?.nodes[currentNode];
    if (graph != null && completedNode != null) {
      const isTerminalNext =
        result.nextNode === "__end__" ||
        result.nextNode === "end" ||
        result.nextNode === "done" ||
        (result.nextNode != null && graph.nodes[result.nextNode]?.type === "exit");
      // Synthetic outcome map: prior gates from routing + this turn's gate.
      const priorOutcomes = readGateOutcomes(state.routing);
      const synthOutcomes = new Map(priorOutcomes);
      if (completedNode.attrs.goal_gate === true && result.outcomeStatus != null) {
        synthOutcomes.set(currentNode, result.outcomeStatus);
      }
      const nonGateFail = result.outcomeStatus === "fail" && completedNode.attrs.goal_gate !== true;
      if (isTerminalNext && !nonGateFail) {
        // Read override from effectiveRouting (state.routing merged with
        // this turn's routingDelta) so intent.goal_gate_adjusted applied
        // in the same dispatch cycle is immediately visible.
        const goalGateOverride = getLimits(effectiveRouting).maxGoalGateRetries ?? 0;
        // Pre-check to discover the failing gate so we can read its cap.
        const gateCheck = checkGoalGates(graph, synthOutcomes);
        const gateCap = gateCheck.satisfied ? 0 : readNumber(graph.nodes[gateCheck.failedGate]?.attrs.max_retries);
        const action = goalGateStep({
          graph,
          outcomes: synthOutcomes,
          retries: readGoalGateRetries(state.routing),
          gateCap,
          ...(goalGateOverride > 0 ? { capOverride: goalGateOverride } : {}),
        });
        if (action.kind === "retarget") {
          goalGateRetargetTarget = action.target;
          goalGateRetriesPatch = action.nextRetries;
          result.nextNode = action.target;
          observability.push({
            type: "goal_gate.retarget",
            payload: { failedGate: action.gate, target: action.target, retries: action.nextRetries },
          });
        } else if (action.kind === "halt") {
          observability.push({
            type: "goal_gate.unsatisfied",
            payload: { gate: action.gate },
          });
          const goalGateLimit =
            (getLimits(effectiveRouting).maxGoalGateRetries ?? 0) ||
            readNumber(graph.nodes[action.gate]?.attrs.max_retries);
          result = {
            kind: "halt",
            reason: "goal_gate_unsatisfied",
            detail: action.gate,
            pauseContext: { currentLimit: goalGateLimit },
          };
        }
      }
    }
  }
  const goalGateOut: GoalGateOutcome = { result, observability };
  if (goalGateRetargetTarget !== undefined) goalGateOut.goalGateRetargetTarget = goalGateRetargetTarget;
  if (goalGateRetriesPatch !== undefined) goalGateOut.goalGateRetriesPatch = goalGateRetriesPatch;
  return goalGateOut;
}

/** Stage 4 output: the (possibly retry-rewritten) result plus the counter
 * patch / pause sentinels the executor applies after `resultToFacts`. */
export interface RetryGateOutcome {
  result: HandlerResult;
  observability: PlannedObservability[];
  retryCounterPatch?: Record<string, number>;
  retryPause?: RetryPause;
  retriesExhaustedPause?: RetriesExhaustedPause;
}

// Retry-policy enforcement (attractor §3.5 / §3.6). When the handler
// returns outcomeStatus="retry", consult retryStep to decide:
//   - retry → emit fact.run_paused{reason:"handler_retry"}
//     (transitions to paused_auto, freeing the slot);
//     wake-pending re-queues the run after delayMs
//   - halt → run halts with `max_retries_exceeded`
//   - advance_partial → rewrite outcomeStatus to "success"
//     and let edge selection advance (allow_partial branch, §3.5)
//
// For the retry path we DO emit fact.node_completed first (metrics
// are real spend), THEN swap fact.node_started for fact.run_paused{reason:"handler_retry"}
// — the run sleeps without a slot held, and resume re-dispatches the
// same node since state.currentNode points back at the retrying id.
/** Stage 4 — retry gate (pause / exhaust / partial). Operates on a clone; the
 * caller's `args.result` is never mutated. */
export function applyRetryGate(args: {
  result: HandlerResult;
  graph: Graph | null;
  state: RunState;
  currentNode: string;
  effectiveRouting: Readonly<Record<string, unknown>>;
  now: number;
  random: () => number;
}): RetryGateOutcome {
  const { graph, state, currentNode, effectiveRouting, now, random } = args;
  // Clone so the `nextNode = currentNode` / `outcomeStatus` rewrites land on
  // our copy, never the caller's object (shared with the goal-gate stage).
  const result = args.result.kind === "transition" ? { ...args.result } : args.result;
  const observability: PlannedObservability[] = [];
  let retryCounterPatch: Record<string, number> | undefined;
  // Per attractor §3.5: reset the counter when this node succeeds so
  // a re-entry via goal-gate retarget (§3.4) or a fail-edge loop
  // starts at zero instead of inheriting the prior pass's count.
  if (result.kind === "transition" && result.outcomeStatus === "success") {
    const counterKey = retryCountKey(currentNode);
    if (getRetry(state.routing).count(currentNode) > 0) {
      retryCounterPatch = { [counterKey]: 0 };
    }
  }
  let retryPause: RetryPause | undefined;
  // Stage 3: retry-counter exhaustion becomes an operator-resumable
  // pause instead of a terminal halt. Sentinel mirrors `budgetPause`
  // / `retryPause` —
  // populated in the action.kind === "halt" branch below, consumed
  // in the post-resultToFacts pass that swaps fact.node_started for
  // fact.run_paused{reason:"max_retries"}.
  let retriesExhaustedPause: RetriesExhaustedPause | undefined;
  if (result.kind === "transition" && result.outcomeStatus === "retry") {
    const completedNode = graph?.nodes[currentNode];
    if (graph != null && completedNode != null) {
      const backoff = resolveBackoff(completedNode.attrs, graph.attrs);
      // Operator override (intent.max_retries_adjusted) takes
      // precedence over the static node/graph attrs. Stage 3
      // pause-converted halt: a Raise & Resume after a max_retries
      // pause should let the next dispatch see the higher cap.
      // Read from `effectiveRouting` (state.routing merged with the
      // current dispatch's fold delta) so an override consumed in
      // the same turn as the resume is honoured immediately —
      // mirrors the budget-override reader, and matches the comment
      // on `effectiveRouting`.
      const maxRetriesOverride = getLimits(effectiveRouting).maxRetries(currentNode) ?? 0;
      const maxRetries =
        maxRetriesOverride > 0 ? maxRetriesOverride : resolveMaxRetries(completedNode.attrs, graph.attrs);
      // allow_partial was a legacy retry-policy escape hatch; dropped.
      const allowPartial = false;
      const counterKey = retryCountKey(currentNode);
      const priorRetries = getRetry(state.routing).count(currentNode);
      const action = retryStep({
        state: { retries: priorRetries, maxRetries },
        status: "retry",
        backoff,
        allowPartial,
        random,
      });
      if (action.kind === "retry") {
        const resumeAt = now + Math.max(0, Math.round(action.delayMs));
        observability.push({
          type: "node.retry_scheduled",
          payload: {
            nodeId: currentNode,
            attempt: priorRetries + 1,
            delayMs: action.delayMs,
            maxRetries,
            resumeAt,
          },
        });
        // Set nextNode = currentNode so fact.node_completed records
        // the loop intent (state.currentNode lands on the retrying
        // node; resume re-dispatches it).
        result.nextNode = currentNode;
        retryCounterPatch = {
          [counterKey]: priorRetries + 1,
        };
        retryPause = {
          nodeId: currentNode,
          attempt: priorRetries + 1,
          delayMs: action.delayMs,
          resumeAt,
          maxRetries,
        };
      } else if (action.kind === "halt") {
        observability.push({
          type: "node.retry_exhausted",
          payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
        });
        // Stage 3 (§3.1): emit a pause instead of a halt. Leave
        // `result` as the transition shape with `outcomeStatus: "retry"`
        // and `nextNode = currentNode` so resultToFacts emits
        // fact.node_completed (preserving real spend) + fact.node_started;
        // the post-resultToFacts pass strips fact.node_started and emits
        // fact.run_paused. Counter
        // semantics per §4: the per-node retry counter is NOT reset
        // here — naked intent.resume re-dispatches with priorRetries
        // unchanged and immediately re-exhausts; a Raise & Resume
        // (intent.max_retries_adjusted writing routing.
        // max_retries_override.<nodeId> + intent.resume) grants
        // (newLimit − priorRetries) more attempts.
        retriesExhaustedPause = {
          nodeId: currentNode,
          currentLimit: maxRetries,
          attempts: priorRetries + 1,
        };
        result.nextNode = currentNode;
      } else if (action.kind === "advance_partial") {
        observability.push({
          type: "node.retry_partial_accept",
          payload: { nodeId: currentNode, attempts: priorRetries + 1, maxRetries },
        });
        result.outcomeStatus = "success";
      }
    }
  }
  const retryOut: RetryGateOutcome = { result, observability };
  if (retryCounterPatch !== undefined) retryOut.retryCounterPatch = retryCounterPatch;
  if (retryPause !== undefined) retryOut.retryPause = retryPause;
  if (retriesExhaustedPause !== undefined) retryOut.retriesExhaustedPause = retriesExhaustedPause;
  return retryOut;
}

/** Stage 5 output: the provider auto-retry decision (or the exhausted
 * sentinel) the fact-rewrite pipeline consumes. */
export interface ProviderRetryOutcome {
  providerRetryDecision?: ProviderRetryDecision;
  providerExhausted?: { attempt: number; reason: "max_attempts" | "max_cumulative_ms" };
}

/** Stage 5 — provider auto-retry. When a llm turn returns pause_provider,
 * consult the policy module to decide whether this is auto-retry (transient
 * transport error, schedule a backoff), manual (operator must intervene —
 * auth/billing/schema), or halt-exhausted (chain cap exceeded). The decision
 * drives fact mutation + routing patches downstream; manual is the existing
 * behaviour and needs no further work. The exhausted branch yields a
 * `provider_exhausted` sentinel — that reason is executor-only (not in the
 * handler-side HaltReason union) so it doesn't go through resultToFacts. */
export function applyProviderRetry(args: {
  result: HandlerResult;
  state: RunState;
  now: number;
  random: () => number;
}): ProviderRetryOutcome {
  const { result, state, now, random } = args;
  let providerRetryDecision: ProviderRetryDecision | undefined;
  let providerExhausted: { attempt: number; reason: "max_attempts" | "max_cumulative_ms" } | undefined;
  if (result.kind === "pause_provider") {
    const providerDecision = decideProviderRetry({
      httpStatus: result.httpStatus,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      priorAttempt: getRetry(state.routing).providerAttempt,
      now,
      cumulativeDelayMs: getRetry(state.routing).providerCumulativeMs,
      random,
    });
    if (providerDecision.kind === "exhausted") {
      providerExhausted = { attempt: providerDecision.attempt, reason: providerDecision.reason };
    } else {
      // auto-retry drives the rewrite below; manual is the existing
      // behaviour (the `?.kind === "auto-retry"` guards skip it).
      providerRetryDecision = providerDecision;
    }
  }
  const providerOut: ProviderRetryOutcome = {};
  if (providerRetryDecision !== undefined) providerOut.providerRetryDecision = providerRetryDecision;
  if (providerExhausted !== undefined) providerOut.providerExhausted = providerExhausted;
  return providerOut;
}

/** Stage 6 — the terminal fact-rewrite pipeline. Takes the `resultToFacts`
 * batch and applies the halt / pause / complete rewrites in their fixed
 * order. Pure: returns a fresh fact list. */
export function rewriteTerminalFacts(args: {
  facts: FactEvent[];
  result: HandlerResult;
  state: RunState;
  decision: ProceedDecision;
  goalGateRetargetTarget?: string;
  goalGateRetriesPatch?: number;
  retryPause?: RetryPause;
  retriesExhaustedPause?: RetriesExhaustedPause;
  providerExhausted?: { attempt: number; reason: "max_attempts" | "max_cumulative_ms" };
  providerRetryDecision?: ProviderRetryDecision;
  budgetPause?: BudgetPause;
  budgetHaltDetail?: string;
}): FactEvent[] {
  const {
    result,
    state,
    decision,
    goalGateRetargetTarget,
    goalGateRetriesPatch,
    retryPause,
    retriesExhaustedPause,
    providerExhausted,
    providerRetryDecision,
    budgetPause,
    budgetHaltDetail,
  } = args;
  // Copy up front so every rewrite below (including the provider-auto-retry
  // branch's in-place facts[i]/push) operates on our list, never the caller's.
  let facts = [...args.facts];

  // A goal-gate retarget's node_started opens the NEXT pass: the epoch bump
  // (`goal_gates.__retries`) rides this same commit's routingPatch, but
  // resultToFacts stamped the pre-bump value read from state — leaving the
  // target's pass-N projection entry "running" forever while every later
  // fact for it carries pass N+1. Stamp the post-bump epoch.
  if (goalGateRetargetTarget !== undefined && goalGateRetriesPatch !== undefined) {
    facts = facts.map((f) =>
      f.type === "fact.node_started" && f.payload.nodeId === goalGateRetargetTarget
        ? { ...f, payload: { ...f.payload, pass: goalGateRetriesPatch } }
        : f,
    );
  }

  // R3 — pause defers when paired with steer/hitl: keep the
  // node_completed accounting, then pause instead of advancing to
  // the next node. wakePending will rouse the run on the next
  // intent.human_input. Terminal halts (run_terminated{errored}) beat pause;
  // we only swap the success continuations (node_started /
  // run_terminated{completed}).
  // Mid-dispatch pause races (intent arrives AFTER the fold but
  // BEFORE the handler returned) flow through the abort-throw path:
  // the llm agent rethrows on signal-tripped + aborted-stream
  // so the executor's catch block writes fact.node_aborted, leaves
  // the run running, and the next dispatch's fold consumes the
  // pause intent normally.
  if (result.kind === "transition" && decision.shouldPauseAfterDispatch) {
    const isSuccessContinuation = (f: FactEvent): boolean =>
      f.type === "fact.node_started" || (f.type === "fact.run_terminated" && f.payload.status === "completed");
    const swapped = facts.some(isSuccessContinuation);
    if (swapped) {
      facts = facts.filter((f) => !isSuccessContinuation(f));
      facts.push({
        type: "fact.run_paused",
        payload: {
          reason: "operator",
          nodeId: state.currentNode ?? "",
        },
      });
    }
  }

  // Retry pause: swap fact.node_started for
  // fact.run_paused{reason:"handler_retry"} so the run releases its
  // concurrency slot during the backoff window. node_completed is
  // preserved (metrics + the nextNode=currentNode routing fact).
  // wake-pending re-queues the run once `resumeAt` has elapsed.
  // An operator pause (shouldPauseAfterDispatch) takes precedence over
  // backoff: skip the retry-pause arm so we don't append a second
  // fact.run_paused{reason:"handler_retry"} — that reason is in
  // AUTO_WAKE_PAUSE_REASONS and would let wake-pending auto-resume,
  // silently cancelling the operator's manual pause.
  if (retryPause !== undefined && !decision.shouldPauseAfterDispatch) {
    facts = facts.filter((f) => f.type !== "fact.node_started");
    facts.push({
      type: "fact.run_paused",
      payload: {
        reason: "handler_retry",
        nodeId: retryPause.nodeId,
        attempt: retryPause.attempt,
        delayMs: retryPause.delayMs,
        resumeAt: retryPause.resumeAt,
        maxRetries: retryPause.maxRetries,
      },
    });
  }

  // Stage 3 (§3.1): retry exhaustion swap. Strip fact.node_started
  // (the run pauses instead of advancing) and emit
  // fact.run_paused{reason:"max_retries"}. fact.node_completed is
  // preserved so the metrics + the nextNode=currentNode routing fact
  // are recorded; an operator who clicks Resume re-dispatches the
  // same (nodeId, iteration) with
  // the retry counter intact (§4). The reason is not in
  // AUTO_WAKE_PAUSE_REASONS so the reducer projects status="paused"
  // (operator must act).
  if (retriesExhaustedPause !== undefined) {
    facts = facts.filter((f) => f.type !== "fact.node_started");
    facts.push({
      type: "fact.run_paused",
      payload: {
        reason: "max_retries",
        nodeId: retriesExhaustedPause.nodeId,
        currentLimit: retriesExhaustedPause.currentLimit,
        attempts: retriesExhaustedPause.attempts,
      },
    });
  }

  // Provider exhausted: rewrite the existing
  // fact.run_paused{reason:"provider_error"} (from result-to-facts'
  // pause_provider arm) to a recoverable
  // fact.run_paused{reason:"provider_exhausted"} pause. Stage 3 of
  // recoverable-budget-pause.md flipped this from terminal halt to
  // paused — operators may know the underlying transport issue is
  // fixed and want to retry the chain. cumulativeMs is best-effort
  // 0 because the executor doesn't track elapsed time across the
  // chain locally; the per-attempt facts in fact.provider_retry_attempted
  // carry the timeline.
  if (providerExhausted !== undefined) {
    facts = facts.filter((f) => f.type !== "fact.run_paused");
    facts.push({
      type: "fact.run_paused",
      payload: {
        reason: "provider_exhausted",
        nodeId: state.currentNode ?? "",
        attempts: providerExhausted.attempt,
        cumulativeMs: 0,
      },
    });
  }

  // Provider auto-retry: rewrite the fact.run_paused payload from
  // reason="provider_error" to reason="provider_retry" with
  // attempt + resumeAt so the reducer projects status to
  // `paused_auto` and the wake-pending sweeper auto-resumes once
  // `resumeAt` has elapsed. The chain is recorded separately via
  // fact.provider_retry_attempted (one per attempt).
  if (providerRetryDecision?.kind === "auto-retry") {
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i]!;
      if (f.type === "fact.run_paused" && f.payload.reason === "provider_error") {
        facts[i] = {
          type: "fact.run_paused",
          payload: {
            reason: "provider_retry",
            nodeId: f.payload.nodeId,
            httpStatus: f.payload.httpStatus,
            provider: f.payload.provider,
            errorMessage: f.payload.errorMessage,
            attempt: providerRetryDecision.attempt,
            resumeAt: providerRetryDecision.resumeAt,
          },
        };
        break;
      }
    }
    facts.push({
      type: "fact.provider_retry_attempted",
      payload: {
        nodeId: state.currentNode ?? "",
        attempt: providerRetryDecision.attempt,
        httpStatus: result.kind === "pause_provider" ? result.httpStatus : null,
        delayMs: providerRetryDecision.delayMs,
      },
    });
  }

  // Budget pause: swap fact.node_started for fact.run_paused{reason:"budget"}
  // so the run releases its slot and waits for `intent.budget_adjusted`
  // + `intent.resume`. node_completed is preserved (metrics + the
  // nextNode routing fact). Workflow-declared terminal exits
  // (fact.run_terminated) are preserved — the run is
  // finished and budget enforcement on a clean exit is moot.
  if (budgetPause !== undefined) {
    const alreadyTerminal = facts.some((f) => f.type === "fact.run_terminated");
    if (!alreadyTerminal) {
      facts = facts.filter((f) => f.type !== "fact.node_started");
      facts.push({
        type: "fact.run_paused",
        payload: {
          reason: "budget",
          nodeId: state.currentNode ?? "",
          scope: budgetPause.scope,
          metric: budgetPause.metric,
          limit: budgetPause.limit,
          actual: budgetPause.actual,
        },
      });
    }
  }

  // Budget halt: preserve fact.node_completed (so projection +
  // per-node cost rollup land), then replace whatever transition fact
  // came (fact.run_terminated{completed} for terminal-success,
  // {errored,aborted_exit} for terminal-fail, fact.node_started for non-
  // terminal) with fact.run_terminated{errored,reason:"budget"}. Mirrors
  // the budgetPause shape immediately above — same fact-list mutation,
  // halt instead of pause.
  if (budgetHaltDetail !== undefined) {
    facts = facts.filter((f) => f.type !== "fact.run_terminated" && f.type !== "fact.node_started");
    const haltPayload: { status: "errored"; reason: "budget"; detail?: string } = {
      status: "errored",
      reason: "budget",
    };
    if (budgetHaltDetail.length > 0) haltPayload.detail = budgetHaltDetail;
    facts.push({ type: "fact.run_terminated", payload: haltPayload });
  }

  return facts;
}

/** Stage 7 — the routing patch. Merges the intent fold delta + result with
 * every per-turn override patch (budget-warned tags, retry counter / wake
 * timestamp, provider-retry chain counter, goal-gate outcome + epoch). */
export function buildRoutingPatch(args: {
  result: HandlerResult;
  decision: ProceedDecision;
  state: RunState;
  currentNode: string;
  graph: Graph | null;
  effectiveRouting: Readonly<Record<string, unknown>>;
  budgetWarnedTags: readonly string[];
  retryCounterPatch?: Record<string, number>;
  retryPause?: RetryPause;
  providerRetryDecision?: ProviderRetryDecision;
  goalGateRetargetTarget?: string;
  goalGateRetriesPatch?: number;
}): Record<string, unknown> | undefined {
  const {
    result,
    decision,
    state,
    currentNode,
    graph,
    effectiveRouting,
    budgetWarnedTags,
    retryCounterPatch,
    retryPause,
    providerRetryDecision,
    goalGateRetargetTarget,
    goalGateRetriesPatch,
  } = args;
  let routingPatch = mergeRoutingPatches(decision.routingDelta, result);
  if (budgetWarnedTags.length > 0) {
    const prior = readBudgetWarned(effectiveRouting);
    const merged = new Set(prior);
    for (const tag of budgetWarnedTags) merged.add(tag);
    routingPatch = { ...(routingPatch ?? {}), [BUDGET_WARNED_KEY]: [...merged].sort() };
  }
  // Per-node retry counter: bumped when retryStep returned `retry`
  // above. Lives at `internal.retry_count.<nodeId>` (see
  // packages/core/src/types/context.ts:retryCountKey).
  if (retryCounterPatch !== undefined) {
    routingPatch = { ...(routingPatch ?? {}), ...retryCounterPatch };
  }
  // Retry pause: stamp the wake-eligibility timestamp so wake-pending
  // can re-queue this run when the backoff has elapsed.
  if (retryPause !== undefined) {
    routingPatch = { ...(routingPatch ?? {}), [AUTO_RESUME_AT_KEY]: retryPause.resumeAt };
  }
  // Provider auto-retry: same shape, plus persist the attempt counter
  // so the next pause_provider in the chain reads it and the cap
  // bounds the run even across manual `intent.resume` interruptions.
  if (providerRetryDecision?.kind === "auto-retry") {
    routingPatch = {
      ...(routingPatch ?? {}),
      [AUTO_RESUME_AT_KEY]: providerRetryDecision.resumeAt,
      [PROVIDER_RETRY_ATTEMPT_KEY]: providerRetryDecision.attempt,
      [PROVIDER_RETRY_CUMULATIVE_MS_KEY]: getRetry(state.routing).providerCumulativeMs + providerRetryDecision.delayMs,
    };
  }
  // Clear the provider-retry chain counter + cumulative on any successful
  // turn so future failures in this run start a fresh chain. Keep them
  // on `transition` outcomes regardless of outcomeStatus — a `fail`
  // outcome from the agent (not a transport error) means the call
  // landed; the chain-counter doesn't apply.
  if (result.kind === "transition" && getRetry(state.routing).providerAttempt > 0) {
    routingPatch = {
      ...(routingPatch ?? {}),
      [PROVIDER_RETRY_ATTEMPT_KEY]: 0,
      [PROVIDER_RETRY_CUMULATIVE_MS_KEY]: 0,
    };
  }
  // Goal-gate routing keys: record the completed gate's outcome and
  // (when goalGateStep retargeted) the bumped retry counter. These keys
  // power the §3.4 fold across turns — readGateOutcomes /
  // readGoalGateRetries pick them up next turn.
  if (result.kind === "transition") {
    const completedNode = graph?.nodes[currentNode];
    if (completedNode?.attrs.goal_gate === true && result.outcomeStatus != null) {
      routingPatch = {
        ...(routingPatch ?? {}),
        [goalGateOutcomeKey(currentNode)]: result.outcomeStatus,
      };
    }
    if (goalGateRetargetTarget !== undefined && goalGateRetriesPatch !== undefined) {
      routingPatch = {
        ...(routingPatch ?? {}),
        [GOAL_GATE_RETRIES_KEY]: goalGateRetriesPatch,
      };
    }
  }
  return routingPatch;
}

/** Stage 8 — the applied-seq watermark advance: the high-water mark of the
 * intent seqs this turn folded, or undefined when nothing was applied. */
export function computeAdvanceAppliedTo(appliedSeqs: readonly number[]): number | undefined {
  return appliedSeqs.length > 0 ? Math.max(...appliedSeqs) : undefined;
}

/** Given a successful (non-abort) handler turn's inputs, decide what comes
 * out: the facts to commit, the routing patch, the applied-seq advance, and
 * the observability trail. The explicit composition of the eight pure
 * stages — no store reads, no clock, no RNG, no I/O. */
export function planTransition(input: TransitionInput): TransitionPlan {
  const { state, decision, graph, effectiveRouting, currentNode, iteration, now, random } = input;

  // Stage 1 — edge selection (clones the handler result internally).
  const edge = selectTransitionEdge({
    handlerResult: input.handlerResult,
    graph,
    currentNode,
    accounting: input.accounting,
  });
  const { pendingEdgeSelection, convertedTransitionUsage } = edge;

  const observability: PlannedObservability[] = [];

  // Stage 2 — budget gate (reads the post-edge-selection result, before
  // goal-gate can rewrite it).
  const budget = applyBudgetGate({
    result: edge.result,
    graph,
    state,
    currentNode,
    iteration,
    effectiveRouting,
  });
  observability.push(...budget.observability);

  // Stage 3 — goal-gate retarget / halt.
  const goalGate = applyGoalGate({
    result: edge.result,
    graph,
    state,
    currentNode,
    effectiveRouting,
  });
  observability.push(...goalGate.observability);

  // edge.selected lands AFTER the goal-gate check: a retarget overrides the
  // selected edge (the originally-picked edge was never traversed), so we
  // suppress its `edge.selected`. Otherwise emit it now, before
  // node_completed lands, preserving the conventional ordering.
  if (
    pendingEdgeSelection !== undefined &&
    goalGate.goalGateRetargetTarget === undefined &&
    goalGate.result.kind === "transition"
  ) {
    recordEdgeSelected(
      observability,
      currentNode,
      iteration,
      pendingEdgeSelection,
      readGoalGateRetries(effectiveRouting),
    );
  }

  // Stage 4 — retry gate (pause / exhaust / partial).
  const retry = applyRetryGate({
    result: goalGate.result,
    graph,
    state,
    currentNode,
    effectiveRouting,
    now,
    random,
  });
  observability.push(...retry.observability);
  const result = retry.result;

  // A goal-gate retarget only counts when it SURVIVES the retry gate: a
  // node converting to a handler_retry pause overwrites `nextNode` back to
  // itself, so the gate's retarget was spurious — don't consume its retry
  // slot or stamp the target's epoch (no node_started for it is emitted).
  // A budget pause is the same story: rewriteTerminalFacts strips the
  // target's fact.node_started and leaves current_node at the gate, so on
  // resume the gate re-executes — bumping GOAL_GATE_RETRIES_KEY here would
  // double-count and prematurely exhaust the cap under repeated budget pauses.
  const retargetApplied =
    goalGate.goalGateRetargetTarget !== undefined &&
    result.kind === "transition" &&
    result.nextNode === goalGate.goalGateRetargetTarget &&
    budget.budgetPause === undefined;

  // Stage 5 — provider auto-retry.
  const provider = applyProviderRetry({ result, state, now, random });

  // Side-effect facts are already durable via the pre-commit recorder;
  // resultToFacts only emits the terminal node_* / run_* facts.
  const factsCtx = {
    state,
    appliedIntentSeqs: decision.appliedSeqs,
    usage: convertedTransitionUsage ?? input.accounting,
  };

  // Stage 6 — the terminal fact-rewrite pipeline.
  const facts = rewriteTerminalFacts({
    facts: resultToFacts(result, factsCtx),
    result,
    state,
    decision,
    ...(retargetApplied && goalGate.goalGateRetargetTarget !== undefined
      ? { goalGateRetargetTarget: goalGate.goalGateRetargetTarget }
      : {}),
    ...(retargetApplied && goalGate.goalGateRetriesPatch !== undefined
      ? { goalGateRetriesPatch: goalGate.goalGateRetriesPatch }
      : {}),
    ...(retry.retryPause !== undefined ? { retryPause: retry.retryPause } : {}),
    ...(retry.retriesExhaustedPause !== undefined ? { retriesExhaustedPause: retry.retriesExhaustedPause } : {}),
    ...(provider.providerExhausted !== undefined ? { providerExhausted: provider.providerExhausted } : {}),
    ...(provider.providerRetryDecision !== undefined ? { providerRetryDecision: provider.providerRetryDecision } : {}),
    ...(budget.budgetPause !== undefined ? { budgetPause: budget.budgetPause } : {}),
    ...(budget.budgetHaltDetail !== undefined ? { budgetHaltDetail: budget.budgetHaltDetail } : {}),
  });

  // Stage 7 — the routing patch.
  const routingPatch = buildRoutingPatch({
    result,
    decision,
    state,
    currentNode,
    graph,
    effectiveRouting,
    budgetWarnedTags: budget.budgetWarnedTags,
    ...(retry.retryCounterPatch !== undefined ? { retryCounterPatch: retry.retryCounterPatch } : {}),
    ...(retry.retryPause !== undefined ? { retryPause: retry.retryPause } : {}),
    ...(provider.providerRetryDecision !== undefined ? { providerRetryDecision: provider.providerRetryDecision } : {}),
    ...(retargetApplied && goalGate.goalGateRetargetTarget !== undefined
      ? { goalGateRetargetTarget: goalGate.goalGateRetargetTarget }
      : {}),
    ...(retargetApplied && goalGate.goalGateRetriesPatch !== undefined
      ? { goalGateRetriesPatch: goalGate.goalGateRetriesPatch }
      : {}),
  });

  // Stage 8 — the applied-seq watermark advance.
  const advanceAppliedTo = computeAdvanceAppliedTo(decision.appliedSeqs);

  const plan: TransitionPlan = { facts, observability };
  if (routingPatch !== undefined) plan.routingPatch = routingPatch;
  if (advanceAppliedTo !== undefined) plan.advanceAppliedTo = advanceAppliedTo;
  return plan;
}
