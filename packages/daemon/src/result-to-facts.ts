// Translate a HandlerResult + intent decision into the FactEvent batch that
// the executor will commit in one appendFact.

import type * as handler from "@swarm/core/handler";
import type { FactEvent, RunState } from "@swarm/store";

type HandlerResult = handler.HandlerResult;

export interface ResultContext {
  state: RunState;
  /** Intents folded before the handler ran; we cite them in steering_applied. */
  appliedIntentSeqs: number[];
  /** Side-effect facts recorded during the handler (from SideEffectRecorder). */
  sideEffectFacts: FactEvent[];
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

  // Pre-facts: steering_applied + run_resumed if applicable.
  if (ctx.appliedIntentSeqs.length > 0) {
    const folded = ctx.appliedIntentSeqs.join(",");
    for (const seq of ctx.appliedIntentSeqs) {
      facts.push({
        type: "fact.steering_applied",
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

  // Record side effects that happened during the handler.
  facts.push(...ctx.sideEffectFacts);

  // Result-specific facts.
  switch (result.kind) {
    case "transition": {
      const payload: Extract<FactEvent, { type: "fact.node_completed" }>["payload"] = {
        nodeId: ctx.state.currentNode ?? "",
        iteration: loopCounterOf(ctx.state.routing),
        tokens: result.tokens,
        costUsd: result.costUsd,
        nextNode: result.nextNode,
      };
      if (result.outputRef != null) {
        payload.outputRef = `${result.outputRef.nodeId}:${result.outputRef.key}`;
      }
      if (result.modelName != null) payload.modelName = result.modelName;
      facts.push({ type: "fact.node_completed", payload });

      if (isTerminalNode(result.nextNode)) {
        facts.push({
          type: "fact.run_completed",
          payload: { finalNode: result.nextNode },
        });
      } else {
        facts.push({
          type: "fact.node_started",
          payload: { nodeId: result.nextNode, iteration: 0 },
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
  }
}

export function abortResultToFacts(
  nodeId: string,
  iteration: number,
  cause: string,
  partial: { tokens: number; costUsd: number },
  sideEffectFacts: FactEvent[],
): FactEvent[] {
  return [
    ...sideEffectFacts,
    {
      type: "fact.node_aborted",
      payload: {
        nodeId,
        iteration,
        cause,
        partialTokens: partial.tokens,
        partialCostUsd: partial.costUsd,
      },
    },
  ];
}

export function cancelToFacts(intentSeq: number): FactEvent[] {
  return [{ type: "fact.run_cancelled", payload: { intentSeq } }];
}

function loopCounterOf(routing: Record<string, unknown>): number {
  const v = routing["loop_counter"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sentinel convention: a transition with nextNode === "__end__" terminates the run. */
function isTerminalNode(nodeId: string): boolean {
  return nodeId === "__end__" || nodeId === "end" || nodeId === "done";
}
