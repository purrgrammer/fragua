// Translate a HandlerResult + intent decision into the FactEvent batch that
// the executor will commit in one appendFact. Side-effect facts
// (intent / done / failed) are NOT included — they're already durable via
// the pre-commit recorder before this function runs.

import { getRetry, readGoalGateRetries } from "@fragua/core";
import type * as handler from "@fragua/core/handler";
import type { FactEvent, RunState } from "@fragua/store";
import { passField, type UsageTotals } from "./executor-helpers.ts";

type HandlerResult = handler.HandlerResult;

export interface ResultContext {
  state: RunState;
  /** Intents folded before the handler ran; we cite them in intents_folded. */
  appliedIntentSeqs: number[];
  /** For cancel: the seq of the cancel intent. */
  cancelIntentSeq?: number;
  /** This turn's accrued spend, for halts that bypass both
   * `fact.node_completed` and `fact.node_aborted` (route_not_picked /
   * route_call_not_isolated / edge_no_match, handler-returned error or
   * budget halts). The halt arm surfaces it as `partial*` fields on
   * `fact.run_terminated{status:errored}` — mirroring `abortResultToFacts` — so the reducer
   * folds the halted turn into `run_state.metrics` instead of dropping
   * it. The pause translations and non-halt arms ignore it (their fact
   * lists either carry a spend-bearing `fact.node_completed` already or
   * the run resumes and the spend lands on a later fact). */
  usage?: HaltUsage;
}

/** Turn-spend shape the halt arm reads. Structurally satisfied by both the
 * executor's `UsageTotals` and the planner's `TurnAccounting` (bucket-cost
 * splits optional — the `addUsage` lane has no bucket-cost source). */
export interface HaltUsage {
  turnBilled: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalInputCostUsd?: number;
  totalOutputCostUsd?: number;
  totalCacheReadCostUsd?: number;
  totalCacheWriteCostUsd?: number;
}

/**
 * Facts to emit AFTER a handler completes successfully.
 *
 * We never call this when the handler was aborted mid-flight; that path uses
 * abortResultToFacts instead.
 */
export function resultToFacts(result: HandlerResult, ctx: ResultContext): FactEvent[] {
  const facts: FactEvent[] = [];

  // Pre-facts: intents_folded + run_resumed if applicable.
  if (ctx.appliedIntentSeqs.length > 0) {
    const folded = ctx.appliedIntentSeqs.join(",");
    for (const seq of ctx.appliedIntentSeqs) {
      facts.push({
        type: "fact.intents_folded",
        payload: { intentSeq: seq, folded },
      });
    }
  }

  // No `fact.run_resumed` emitted here. `wakeHuman` / `wakeResume` /
  // `wakeUnquarantine` already commit the resume fact when the wake
  // intent is processed (see daemon/src/wake-pending.ts) — re-emitting
  // it on dispatch completion was a leftover from M3's earlier design
  // and produced a redundant `fromStatus: "running"` row in the feed.

  // Result-specific facts.
  switch (result.kind) {
    case "transition": {
      // The executor resolves edge selection before calling resultToFacts,
      // so nextNode is populated by this point. Defaulting to __end__
      // matches the "no outgoing edges" terminal rule if anything upstream
      // missed the substitution.
      const nextNode = result.nextNode ?? "__end__";
      const pass = readGoalGateRetries(ctx.state.routing);
      const payload: Extract<FactEvent, { type: "fact.node_completed" }>["payload"] = {
        nodeId: ctx.state.currentNode ?? "",
        iteration: nodeRetryCount(ctx.state.routing, ctx.state.currentNode ?? ""),
        tokens: result.tokens,
        costUsd: result.costUsd,
        nextNode,
      };
      // Goal-gate re-entry epoch: a retarget pass resets per-node retry
      // counters (§3.4), so `(nodeId, iteration)` alone collides across
      // passes — the epoch keeps each pass's facts distinct.
      Object.assign(payload, passField(pass));
      if (result.modelName != null) payload.modelName = result.modelName;
      if (result.outcomeStatus != null) payload.outcomeStatus = result.outcomeStatus;
      // Route field lands on the fact only when a routing-node llm
      // committed to a branch via the synthesised `route` tool.
      // Non-routing nodes leave
      // `result.route` undefined; the field stays absent from the JSON.
      if (result.route != null && result.route.length > 0) payload.route = result.route;
      // Structured outputs: attach unconditionally. The store spills an
      // oversized struct to the blob CAS at append time (the event keeps a tiny
      // `{$fragua_blob}` ref under the 4 KiB cap), so size is no longer a node
      // failure — `result-to-facts` stays a pure size-agnostic projection.
      if (result.outputs !== undefined) {
        payload.outputs = result.outputs as Record<string, unknown>;
      }
      // Input/output/cache split — emit only when non-zero so legacy
      // handlers without the split keep their payload size unchanged
      // (§I7 keeps events ≤4KB).
      if (result.inputTokens != null && result.inputTokens > 0) payload.inputTokens = result.inputTokens;
      if (result.outputTokens != null && result.outputTokens > 0) payload.outputTokens = result.outputTokens;
      if (result.cacheReadTokens != null && result.cacheReadTokens > 0) {
        payload.cacheReadTokens = result.cacheReadTokens;
      }
      if (result.cacheWriteTokens != null && result.cacheWriteTokens > 0) {
        payload.cacheWriteTokens = result.cacheWriteTokens;
      }
      if (result.inputCostUsd != null && result.inputCostUsd > 0) payload.inputCostUsd = result.inputCostUsd;
      if (result.outputCostUsd != null && result.outputCostUsd > 0) payload.outputCostUsd = result.outputCostUsd;
      if (result.cacheReadCostUsd != null && result.cacheReadCostUsd > 0) {
        payload.cacheReadCostUsd = result.cacheReadCostUsd;
      }
      if (result.cacheWriteCostUsd != null && result.cacheWriteCostUsd > 0) {
        payload.cacheWriteCostUsd = result.cacheWriteCostUsd;
      }
      facts.push({ type: "fact.node_completed", payload });

      if (isTerminalNode(nextNode)) {
        // A failure reaches a terminal in two ways, and they mean
        // opposite things:
        //   - `__end__` is the executor's no-fail-route sentinel — the
        //     node failed and the author declared no fail edge. That
        //     halts the run (`aborted_exit`); the reducer maps "halted"
        //     to the UI's "fail" status. The handler's `failureReason`
        //     (e.g. the agent's `<abort>reason</abort>`) surfaces
        //     verbatim as the halt detail.
        //   - An explicit sink (`exit`) reached via a fail edge is a
        //     sanctioned graceful landing the author opted into — the
        //     run completes, not halts.
        if (nextNode === "__end__" && result.outcomeStatus === "fail") {
          const detail =
            typeof result.failureReason === "string" && result.failureReason.length > 0
              ? result.failureReason
              : `node ${ctx.state.currentNode ?? "?"} failed with no fail route`;
          facts.push({
            type: "fact.run_terminated",
            payload: { status: "errored", reason: "aborted_exit", detail },
          });
        } else {
          facts.push({
            type: "fact.run_terminated",
            payload: { status: "completed", finalNode: nextNode },
          });
        }
      } else {
        const startedPayload: Extract<FactEvent, { type: "fact.node_started" }>["payload"] = {
          nodeId: nextNode,
          iteration: nodeRetryCount(ctx.state.routing, nextNode),
        };
        Object.assign(startedPayload, passField(pass));
        facts.push({ type: "fact.node_started", payload: startedPayload });
      }
      return facts;
    }
    case "yield_human": {
      facts.push({
        type: "fact.run_paused",
        payload: {
          reason: "human",
          nodeId: ctx.state.currentNode ?? "",
          text: result.text,
          routes: result.routes,
          ...(result.routeLabels ? { routeLabels: result.routeLabels } : {}),
        },
      });
      return facts;
    }
    case "halt": {
      // Stage 3 of recoverable-budget-pause.md converts three reasons to
      // operator-resumable pauses. `goal_gate_unsatisfied` and `max_loops`
      // still flow through here (the executor sets
      // `result = { kind: "halt", reason: <X> }` at those sites for
      // legibility). `max_retries_exceeded` has migrated to the
      // `retriesExhaustedPause` sentinel in executor.ts and no longer
      // reaches this branch from the executor; the translation below
      // is retained as a safety net for any future caller that still
      // constructs the handler-contract halt shape. Other halts pass
      // through to fact.run_terminated{errored} unchanged.
      const reason = result.reason;
      const nodeId = ctx.state.currentNode ?? "";
      const ctxCurrentLimit = result.pauseContext?.currentLimit ?? 0;
      const ctxAttempts = result.pauseContext?.attempts ?? 0;
      if (reason === "max_retries_exceeded") {
        facts.push({
          type: "fact.run_paused",
          payload: { reason: "max_retries", nodeId, currentLimit: ctxCurrentLimit, attempts: ctxAttempts },
        });
        return facts;
      }
      if (reason === "goal_gate_unsatisfied") {
        // result.detail names the failed gate (set by the executor at
        // the goal_gate halt site). Fall back to the current node when
        // detail is missing — defensive, shouldn't normally fire.
        const gateNodeId = result.detail && result.detail.length > 0 ? result.detail : nodeId;
        facts.push({
          type: "fact.run_paused",
          payload: { reason: "goal_gate", gateNodeId, currentLimit: ctxCurrentLimit },
        });
        return facts;
      }
      if (reason === "max_loops") {
        facts.push({
          type: "fact.run_paused",
          payload: { reason: "max_loops", currentLimit: ctxCurrentLimit, dispatches: ctxAttempts },
        });
        return facts;
      }
      const payload: Extract<Extract<FactEvent, { type: "fact.run_terminated" }>["payload"], { status: "errored" }> = {
        status: "errored",
        reason,
      };
      if (result.detail != null) payload.detail = result.detail;
      // Halts reaching this point bypass fact.node_completed AND
      // fact.node_aborted, so the turn's spend would otherwise vanish
      // from run totals. Surface it as partial* fields (same shape and
      // >0 gating as abortResultToFacts) for the reducer to fold. The
      // budget-halt sentinel path never comes through here (it keeps the
      // transition shape so node_completed lands first), so this cannot
      // double-count a turn.
      const usage = ctx.usage;
      if (usage != null && (usage.turnBilled > 0 || usage.totalCostUsd > 0)) {
        payload.nodeId = nodeId;
        payload.partialTokens = usage.turnBilled;
        payload.partialCostUsd = usage.totalCostUsd;
        if (usage.totalInputTokens > 0) payload.partialInputTokens = usage.totalInputTokens;
        if (usage.totalOutputTokens > 0) payload.partialOutputTokens = usage.totalOutputTokens;
        if (usage.totalCacheReadTokens > 0) payload.partialCacheReadTokens = usage.totalCacheReadTokens;
        if (usage.totalCacheWriteTokens > 0) payload.partialCacheWriteTokens = usage.totalCacheWriteTokens;
        const inputCostUsd = usage.totalInputCostUsd ?? 0;
        const outputCostUsd = usage.totalOutputCostUsd ?? 0;
        const cacheReadCostUsd = usage.totalCacheReadCostUsd ?? 0;
        const cacheWriteCostUsd = usage.totalCacheWriteCostUsd ?? 0;
        if (inputCostUsd > 0) payload.partialInputCostUsd = inputCostUsd;
        if (outputCostUsd > 0) payload.partialOutputCostUsd = outputCostUsd;
        if (cacheReadCostUsd > 0) payload.partialCacheReadCostUsd = cacheReadCostUsd;
        if (cacheWriteCostUsd > 0) payload.partialCacheWriteCostUsd = cacheWriteCostUsd;
      }
      facts.push({ type: "fact.run_terminated", payload });
      return facts;
    }
    case "pause_provider": {
      // 402 → reason="payment_required" (top-up off-ledger). Anything else
      // in the manual class lands as reason="provider_error"; the
      // executor rewrites to reason="provider_retry" if the
      // provider-retry decision returns auto-retry (transient transport
      // class — 408/429/5xx/529/network).
      if (result.httpStatus === 402) {
        facts.push({
          type: "fact.run_paused",
          payload: {
            reason: "payment_required",
            nodeId: ctx.state.currentNode ?? "",
            provider: result.provider,
            errorMessage: result.errorMessage,
          },
        });
      } else {
        facts.push({
          type: "fact.run_paused",
          payload: {
            reason: "provider_error",
            nodeId: ctx.state.currentNode ?? "",
            httpStatus: result.httpStatus,
            provider: result.provider,
            errorMessage: result.errorMessage,
          },
        });
      }
      return facts;
    }
  }
}

export function abortResultToFacts(
  nodeId: string,
  iteration: number,
  cause: string,
  partial: UsageTotals,
  pass = 0,
): FactEvent[] {
  const payload: Extract<FactEvent, { type: "fact.node_aborted" }>["payload"] = {
    nodeId,
    iteration,
    cause,
    partialTokens: partial.turnBilled,
    partialCostUsd: partial.totalCostUsd,
  };
  Object.assign(payload, passField(pass));
  if (partial.totalInputTokens > 0) payload.partialInputTokens = partial.totalInputTokens;
  if (partial.totalOutputTokens > 0) payload.partialOutputTokens = partial.totalOutputTokens;
  if (partial.totalCacheReadTokens > 0) payload.partialCacheReadTokens = partial.totalCacheReadTokens;
  if (partial.totalCacheWriteTokens > 0) payload.partialCacheWriteTokens = partial.totalCacheWriteTokens;
  // Per-bucket cost splits keep the analytics invariant (bucket sums ≈
  // total_cost_usd) intact for aborted spend — without them an aborted turn
  // raises the total while the splits stay flat.
  if (partial.totalInputCostUsd > 0) payload.partialInputCostUsd = partial.totalInputCostUsd;
  if (partial.totalOutputCostUsd > 0) payload.partialOutputCostUsd = partial.totalOutputCostUsd;
  if (partial.totalCacheReadCostUsd > 0) payload.partialCacheReadCostUsd = partial.totalCacheReadCostUsd;
  if (partial.totalCacheWriteCostUsd > 0) payload.partialCacheWriteCostUsd = partial.totalCacheWriteCostUsd;
  return [{ type: "fact.node_aborted", payload }];
}

export function cancelToFacts(intentSeq: number): FactEvent[] {
  return [{ type: "fact.run_terminated", payload: { status: "aborted", intentSeq } }];
}

/** Per-node retry counter — bumped each time a
 * backward edge re-enters a node after a non-success outcome. Stored
 * per node at `internal.retry_count.<nodeId>` (retryCountKey); the
 * executor writes it and reads it for the dispatch iteration, so the
 * two stay in sync. Typed read via the `getRetry` accessor. */
function nodeRetryCount(routing: Record<string, unknown>, nodeId: string): number {
  return getRetry(routing).count(nodeId);
}

/** Sentinel convention: a transition with nextNode === "__end__" terminates the run.
 * `exit` is the canonical reserved-sink name in the new GHA-style authoring
 * shape; `end` / `done` are historical aliases retained for compat. */
function isTerminalNode(nodeId: string): boolean {
  return nodeId === "__end__" || nodeId === "exit" || nodeId === "end" || nodeId === "done";
}
