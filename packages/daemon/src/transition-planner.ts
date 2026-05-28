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
  MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY,
  maxRetriesOverrideKey,
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

export function planTransition(input: TransitionInput): TransitionPlan {
  const { state, decision, effectiveRouting, currentNode, iteration, now, random } = input;
  const {
    turnBilled,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    lastModel,
  } = input.accounting;
  const observability: PlannedObservability[] = [];

  // Clone the transition variant so the caller's handler result is never
  // mutated (referential transparency); other kinds flow through unchanged.
  let result: HandlerResult =
    input.handlerResult.kind === "transition" ? { ...input.handlerResult } : input.handlerResult;

  // Edge selection is recorded with `edge.selected` AFTER the
  // goal-gate retarget check, not at selection time. Goal-gate
  // retarget can override `result.nextNode` to a different target
  // (the retry_target), in which case the originally-selected edge
  // is never actually traversed and `edge.selected` would lie. We
  // hold the selection here, then emit it only if no retarget fired.
  let pendingEdgeSelection: EdgeSelection | undefined;

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
      const graph = input.graph;
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
          // `fact.run_halted{reason:"edge_no_match"}` with a
          // diagnostic detail; validator should make this
          // unreachable for a pinned graph.
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

  // Budget enforcement at the post-handler boundary. The check sees
  // cumulative spend INCLUDING this turn (state.metrics doesn't have
  // the new fact applied yet, so we add result.{tokens,costUsd} in).
  // On halt, defer the halt until after resultToFacts so
  // fact.node_completed lands first — without that, the breaching
  // turn's spend is visible to the gate but never folds into
  // run_state.total_cost_usd or nodeCosts[currentNode]; the projection
  // would lag the gate's `actual` by the breaching-turn cost.
  // On warn-only, prepend the warn event(s) to observability and let
  // the transition continue.
  let budgetWarnedTags: readonly string[] = [];
  let budgetPause: { scope: "node" | "run"; metric: "cost" | "tokens"; limit: number; actual: number } | undefined;
  let budgetHaltDetail: string | undefined;
  if (result.kind === "transition") {
    const graph = input.graph;
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

  // Goal-gate enforcement (attractor §3.4). Two responsibilities:
  //   1. Record this node's outcome under `goal_gates.<id>` whenever it
  //      has goal_gate=true, so terminal-arrival can read the fold.
  //   2. When the resolved transition leads to a terminal, check every
  //      visited gate: if any unsatisfied, redirect to the §3.4 chain
  //      (gate.retry_target → gate.fallback_retry_target → graph.retry_target
  //      → graph.fallback_retry_target) bounded by max_goal_gate_retries.
  //   3. Counter exhaust → halt with `goal_gate_unsatisfied`.
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
  // fail-landing (SKILL: "an explicit edge to the `exit` sink on
  // failure is a sanctioned landing — the run *completes*"). One
  // condition, both cases.
  let goalGateRetargetTarget: string | undefined;
  let goalGateRetriesPatch: number | undefined;
  if (result.kind === "transition") {
    const graph = input.graph;
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
        const goalGateOverride = readNumber(effectiveRouting[MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY]);
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
            readNumber(effectiveRouting[MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY]) ||
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

  // Goal-gate retarget (or unsatisfied-halt) overrides the selected
  // edge — the originally-picked edge was never actually traversed,
  // so suppress its `edge.selected`. Otherwise emit it now, before
  // node_completed lands, preserving the conventional ordering.
  if (pendingEdgeSelection !== undefined && goalGateRetargetTarget === undefined && result.kind === "transition") {
    recordEdgeSelected(observability, currentNode, iteration, pendingEdgeSelection);
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
  let retryCounterPatch: Record<string, number> | undefined;
  // Per attractor §3.5: reset the counter when this node succeeds so
  // a re-entry via goal-gate retarget (§3.4) or a fail-edge loop
  // starts at zero instead of inheriting the prior pass's count.
  if (result.kind === "transition" && result.outcomeStatus === "success") {
    const counterKey = retryCountKey(currentNode);
    if (readNumber(state.routing[counterKey]) > 0) {
      retryCounterPatch = { [counterKey]: 0 };
    }
  }
  let retryPause:
    | {
        nodeId: string;
        attempt: number;
        delayMs: number;
        resumeAt: number;
        maxRetries: number;
      }
    | undefined;
  // Stage 3: retry-counter exhaustion becomes an operator-resumable
  // pause instead of a terminal halt. Sentinel mirrors `budgetPause`
  // / `retryPause` —
  // populated in the action.kind === "halt" branch below, consumed
  // in the post-resultToFacts pass that swaps fact.node_started for
  // fact.run_paused{reason:"max_retries"}.
  let retriesExhaustedPause: { nodeId: string; currentLimit: number; attempts: number } | undefined;
  if (result.kind === "transition" && result.outcomeStatus === "retry") {
    const graph = input.graph;
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
      const maxRetriesOverride = readNumber(effectiveRouting[maxRetriesOverrideKey(currentNode)]);
      const maxRetries =
        maxRetriesOverride > 0 ? maxRetriesOverride : resolveMaxRetries(completedNode.attrs, graph.attrs);
      // allow_partial was a legacy retry-policy escape hatch; dropped.
      const allowPartial = false;
      const counterKey = retryCountKey(currentNode);
      const priorRetries = readNumber(state.routing[counterKey]);
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

  // Provider auto-retry: when a llm turn returns pause_provider,
  // consult the policy module to decide whether this is auto-retry
  // (transient transport error, schedule a backoff), manual (operator
  // must intervene — auth/billing/schema), or halt-exhausted (chain
  // cap exceeded). The decision drives fact mutation + routing patches
  // below; manual is the existing behaviour and needs no further work.
  // The exhausted branch emits a `provider_exhausted` halt fact
  // directly — that reason is executor-only (not in the handler-side
  // HaltReason union) so we don't go through resultToFacts.
  let providerRetryDecision: ProviderRetryDecision | undefined;
  let providerExhausted: { attempt: number; reason: "max_attempts" | "max_cumulative_ms" } | undefined;
  if (result.kind === "pause_provider") {
    const providerDecision = decideProviderRetry({
      httpStatus: result.httpStatus,
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      priorAttempt: readNumber(state.routing[PROVIDER_RETRY_ATTEMPT_KEY]),
      now,
      cumulativeDelayMs: 0,
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

  // Side-effect facts are already durable via the pre-commit recorder;
  // resultToFacts only emits the terminal node_* / run_* facts.
  const factsCtx = {
    state,
    appliedIntentSeqs: decision.appliedSeqs,
  };
  let facts = resultToFacts(result, factsCtx);

  // R3 — pause defers when paired with steer/hitl: keep the
  // node_completed accounting, then pause instead of advancing to
  // the next node. wakePending will rouse the run on the next
  // intent.human_input. Terminal halts (run_halted) beat pause; we
  // only swap the success continuations (node_started / run_completed).
  // Mid-dispatch pause races (intent arrives AFTER the fold but
  // BEFORE the handler returned) flow through the abort-throw path:
  // the llm agent rethrows on signal-tripped + aborted-stream
  // so the executor's catch block writes fact.node_aborted, leaves
  // the run running, and the next dispatch's fold consumes the
  // pause intent normally.
  if (result.kind === "transition" && decision.shouldPauseAfterDispatch) {
    const swapTypes = new Set(["fact.node_started", "fact.run_completed"]);
    const swapped = facts.some((f) => swapTypes.has(f.type));
    if (swapped) {
      facts = facts.filter((f) => !swapTypes.has(f.type));
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
  if (retryPause !== undefined) {
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
  // (fact.run_completed / fact.run_halted) are preserved — the run is
  // finished and budget enforcement on a clean exit is moot.
  if (budgetPause !== undefined) {
    const alreadyTerminal = facts.some((f) => f.type === "fact.run_completed" || f.type === "fact.run_halted");
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
  // came (fact.run_completed for terminal-success, fact.run_halted{
  // aborted_exit} for terminal-fail, fact.node_started for non-
  // terminal) with fact.run_halted{reason:"budget"}. Mirrors the
  // budgetPause shape immediately above — same fact-list mutation,
  // halt instead of pause.
  if (budgetHaltDetail !== undefined) {
    facts = facts.filter(
      (f) => f.type !== "fact.run_completed" && f.type !== "fact.run_halted" && f.type !== "fact.node_started",
    );
    const haltPayload: { reason: "budget"; detail?: string } = { reason: "budget" };
    if (budgetHaltDetail.length > 0) haltPayload.detail = budgetHaltDetail;
    facts.push({ type: "fact.run_halted", payload: haltPayload });
  }

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
    };
  }
  // Clear the provider-retry chain counter on any successful turn
  // so future failures in this run start a fresh chain. Keep the
  // counter on `transition` outcomes regardless of outcomeStatus —
  // a `fail` outcome from the agent (not a transport error) means
  // the call landed; the chain-counter doesn't apply.
  if (result.kind === "transition" && readNumber(state.routing[PROVIDER_RETRY_ATTEMPT_KEY]) > 0) {
    routingPatch = { ...(routingPatch ?? {}), [PROVIDER_RETRY_ATTEMPT_KEY]: 0 };
  }
  // Goal-gate routing keys: record the completed gate's outcome and
  // (when goalGateStep retargeted) the bumped retry counter. These keys
  // power the §3.4 fold across turns — readGateOutcomes /
  // readGoalGateRetries pick them up next turn.
  if (result.kind === "transition") {
    const graph = input.graph;
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
  const advanceAppliedTo = decision.appliedSeqs.length > 0 ? Math.max(...decision.appliedSeqs) : undefined;

  const plan: TransitionPlan = { facts, observability };
  if (routingPatch !== undefined) plan.routingPatch = routingPatch;
  if (advanceAppliedTo !== undefined) plan.advanceAppliedTo = advanceAppliedTo;
  return plan;
}
