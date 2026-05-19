// Translate a HandlerResult + intent decision into the FactEvent batch that
// the executor will commit in one appendFact. Side-effect facts
// (intent / done / failed) are NOT included — they're already durable via
// the pre-commit recorder before this function runs.

import type * as handler from "@swarm/core/handler";
import type { FactEvent, RunState } from "@swarm/store";

type HandlerResult = handler.HandlerResult;

export interface ResultContext {
  state: RunState;
  /** Intents folded before the handler ran; we cite them in intents_folded. */
  appliedIntentSeqs: number[];
  /** For cancel: the seq of the cancel intent. */
  cancelIntentSeq?: number;
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
      const payload: Extract<FactEvent, { type: "fact.node_completed" }>["payload"] = {
        nodeId: ctx.state.currentNode ?? "",
        iteration: nodeRetryCount(ctx.state.routing),
        tokens: result.tokens,
        costUsd: result.costUsd,
        nextNode,
      };
      if (result.modelName != null) payload.modelName = result.modelName;
      if (result.outcomeStatus != null) payload.outcomeStatus = result.outcomeStatus;
      // Route field lands on the fact only when a routing-node codergen
      // committed to a branch via the synthesised `route` tool
      // (docs/proposals/llm-routing.md D8). Non-routing nodes leave
      // `result.route` undefined; the field stays absent from the JSON.
      if (result.route != null && result.route.length > 0) payload.route = result.route;
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
        // A terminal reached via an explicit fail outcome (either the
        // handler returned outcomeStatus="fail" or the edge selector
        // picked a `condition="outcome=fail"` edge that led here) ends
        // the run in a failure state, not success. Reducer maps
        // "halted" to the UI's "fail" status. The handler's
        // `failureReason` (e.g. the agent's `<abort>reason</abort>`)
        // surfaces verbatim as the halt detail so post-mortem readers
        // see *why* the run failed, not just that it routed via a
        // fail edge.
        if (result.outcomeStatus === "fail") {
          const detail =
            typeof result.failureReason === "string" && result.failureReason.length > 0
              ? result.failureReason
              : `reached ${nextNode} via outcome=fail`;
          facts.push({
            type: "fact.run_halted",
            payload: { reason: "aborted_exit", detail },
          });
        } else {
          facts.push({
            type: "fact.run_completed",
            payload: { finalNode: nextNode },
          });
        }
      } else {
        facts.push({
          type: "fact.node_started",
          payload: { nodeId: nextNode, iteration: 0 },
        });
      }
      return facts;
    }
    case "yield_human": {
      facts.push({
        type: "fact.run_paused_human",
        payload: {
          nodeId: ctx.state.currentNode ?? "",
          text: result.text,
          routes: result.routes,
        },
      });
      return facts;
    }
    case "halt": {
      // Stage 3 of docs/proposals/recoverable-budget-pause.md converts
      // three reasons to operator-resumable pauses. `goal_gate_unsatisfied`
      // and `max_loops` still flow through here (the executor sets
      // `result = { kind: "halt", reason: <X> }` at those sites for
      // legibility). `max_retries_exceeded` has migrated to the
      // `retriesExhaustedPause` sentinel in executor.ts (per
      // docs/proposals/paused-max-retries.md §3.1) and no longer
      // reaches this branch from the executor; the translation below
      // is retained as a safety net for any future caller that still
      // constructs the handler-contract halt shape. Other halts pass
      // through to fact.run_halted unchanged.
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
      const payload: Extract<FactEvent, { type: "fact.run_halted" }>["payload"] = { reason };
      if (result.detail != null) payload.detail = result.detail;
      facts.push({ type: "fact.run_halted", payload });
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
  partial: {
    tokens: number;
    costUsd: number;
    inputCostUsd?: number;
    outputCostUsd?: number;
    cacheReadCostUsd?: number;
    cacheWriteCostUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): FactEvent[] {
  const payload: Extract<FactEvent, { type: "fact.node_aborted" }>["payload"] = {
    nodeId,
    iteration,
    cause,
    partialTokens: partial.tokens,
    partialCostUsd: partial.costUsd,
  };
  if (partial.inputCostUsd != null && partial.inputCostUsd > 0) payload.partialInputCostUsd = partial.inputCostUsd;
  if (partial.outputCostUsd != null && partial.outputCostUsd > 0) {
    payload.partialOutputCostUsd = partial.outputCostUsd;
  }
  if (partial.cacheReadCostUsd != null && partial.cacheReadCostUsd > 0) {
    payload.partialCacheReadCostUsd = partial.cacheReadCostUsd;
  }
  if (partial.cacheWriteCostUsd != null && partial.cacheWriteCostUsd > 0) {
    payload.partialCacheWriteCostUsd = partial.cacheWriteCostUsd;
  }
  if (partial.inputTokens != null && partial.inputTokens > 0) payload.partialInputTokens = partial.inputTokens;
  if (partial.outputTokens != null && partial.outputTokens > 0) payload.partialOutputTokens = partial.outputTokens;
  if (partial.cacheReadTokens != null && partial.cacheReadTokens > 0) {
    payload.partialCacheReadTokens = partial.cacheReadTokens;
  }
  if (partial.cacheWriteTokens != null && partial.cacheWriteTokens > 0) {
    payload.partialCacheWriteTokens = partial.cacheWriteTokens;
  }
  return [{ type: "fact.node_aborted", payload }];
}

export function cancelToFacts(intentSeq: number): FactEvent[] {
  return [{ type: "fact.run_cancelled", payload: { intentSeq } }];
}

/** Per-node retry counter (attractor §3.6) — bumped each time a
 * backward edge re-enters a node after a non-success outcome. Shares
 * the `retry_count` routing key with `executor.ts` so the two reads
 * stay in sync. */
function nodeRetryCount(routing: Record<string, unknown>): number {
  const v = routing["retry_count"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sentinel convention: a transition with nextNode === "__end__" terminates the run.
 * `exit` is the canonical reserved-sink name in the new GHA-style authoring
 * shape; `end` / `done` are historical aliases retained for compat. */
function isTerminalNode(nodeId: string): boolean {
  return nodeId === "__end__" || nodeId === "exit" || nodeId === "end" || nodeId === "done";
}
