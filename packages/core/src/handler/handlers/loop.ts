// Graph-level loop handler.
//
// A loop node is a cycle in the DAG. Its handler has a counter-increment
// semantic: bump routing.loop_counter, check the ceiling, transition to the
// body or the exit.
//
// The loop_counter is stored under routing using a loop-scoped key so
// nested loops on different graph nodes don't collide.

import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export interface LoopConfig {
  bodyNode: string;
  exitNode: string;
  maxIterations: number;
  /** Key under routing where the counter lives. Defaults to `loop:${nodeId}`. */
  counterKey?: string;
}

export function makeLoopHandler(cfg: LoopConfig): HandlerSpec {
  const handler: Handler = async (ctx) => {
    const key = cfg.counterKey ?? `loop:${ctx.nodeId}`;
    const prev = asNumber(ctx.routing[key]) ?? 0;
    const next = prev + 1;

    if (next > cfg.maxIterations) {
      return {
        kind: "halt",
        reason: "max_loops",
        detail: `loop ${ctx.nodeId} exceeded ${cfg.maxIterations}`,
      } satisfies HandlerResult;
    }

    return {
      kind: "transition",
      nextNode: cfg.bodyNode,
      routingDelta: { [key]: next, loop_counter: next },
      tokens: 0,
      costUsd: 0,
    } satisfies HandlerResult;
  };

  return {
    kind: "loop",
    sideEffect: "none",
    maxMs: 100,
    handler,
  };
}

/**
 * Companion exit transition — called from a conditional at the end of the
 * loop body once the body decides it's done.
 */
export function makeLoopExitHandler(cfg: LoopConfig): HandlerSpec {
  const handler: Handler = async () => ({
    kind: "transition",
    nextNode: cfg.exitNode,
    routingDelta: { loop_counter: 0 },
    tokens: 0,
    costUsd: 0,
  });
  return {
    kind: "loop_exit",
    sideEffect: "none",
    maxMs: 50,
    handler,
  };
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
