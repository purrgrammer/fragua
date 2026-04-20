// wait.human handler — ARCHITECTURE.md §0.
//
// First call: returns yield_hitl. The executor emits fact.run_paused_hitl
// and releases the fiber. Process is free to die or do other work.
//
// Second call (after intent.hitl_input arrives): ctx.hitlInput is populated
// by the executor from the fold. Returns a transition to nextNode, carrying
// the input in routing so downstream nodes can read it.

import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export interface WaitHumanConfig {
  prompt: string;
  nextNode: string;
  /** Routing key where the HITL input lands on resume. Defaults to `hitl.${nodeId}`. */
  inputKey?: string;
}

export function makeWaitHumanHandler(cfg: WaitHumanConfig): HandlerSpec {
  const handler: Handler = async (ctx) => {
    if (ctx.hitlInput === undefined) {
      return {
        kind: "yield_hitl",
        prompt: cfg.prompt,
      } satisfies HandlerResult;
    }

    const key = cfg.inputKey ?? `hitl.${ctx.nodeId}`;
    return {
      kind: "transition",
      nextNode: cfg.nextNode,
      routingDelta: { [key]: ctx.hitlInput },
      tokens: 0,
      costUsd: 0,
    } satisfies HandlerResult;
  };

  return {
    kind: "wait.human",
    sideEffect: "none",
    maxMs: 1_000,
    handler,
  };
}
