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
  /** For resume from HITL: the seq of the hitl_input intent. */
  hitlInputSeq?: number;
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

  if (ctx.hitlInputSeq != null) {
    facts.push({
      type: "fact.run_resumed",
      payload: {
        fromStatus: ctx.state.status,
        inputIntentSeq: ctx.hitlInputSeq,
      },
    });
  }

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
      if (result.outputRef != null) {
        payload.outputRef = `${result.outputRef.nodeId}:${result.outputRef.key}`;
      }
      if (result.modelName != null) payload.modelName = result.modelName;
      if (result.outcomeStatus != null) payload.outcomeStatus = result.outcomeStatus;
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
      facts.push({ type: "fact.node_completed", payload });

      if (isTerminalNode(nextNode)) {
        // A terminal reached via an explicit fail outcome (either the
        // handler returned outcomeStatus="fail" or the edge selector
        // picked a `condition="outcome=fail"` edge that led here) ends
        // the run in a failure state, not success. Reducer maps
        // "halted" to the UI's "fail" status.
        if (result.outcomeStatus === "fail") {
          facts.push({
            type: "fact.run_halted",
            payload: { reason: "aborted_exit", detail: `reached ${nextNode} via outcome=fail` },
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
    case "yield_hitl": {
      facts.push({
        type: "fact.run_paused_hitl",
        payload: { nodeId: ctx.state.currentNode ?? "", prompt: result.prompt },
      });
      return facts;
    }
    case "halt": {
      const payload: Extract<FactEvent, { type: "fact.run_halted" }>["payload"] = { reason: result.reason };
      if (result.detail != null) payload.detail = result.detail;
      facts.push({ type: "fact.run_halted", payload });
      return facts;
    }
    case "pause_provider": {
      facts.push({
        type: "fact.run_paused_provider_error",
        payload: {
          nodeId: ctx.state.currentNode ?? "",
          httpStatus: result.httpStatus,
          provider: result.provider,
          errorMessage: result.errorMessage,
        },
      });
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

/** Sentinel convention: a transition with nextNode === "__end__" terminates the run. */
function isTerminalNode(nodeId: string): boolean {
  return nodeId === "__end__" || nodeId === "end" || nodeId === "done";
}
