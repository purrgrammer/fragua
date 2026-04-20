// parallel.fan_in handler — attractor-spec §4.9 heuristic branch.
//
// Consumes `parallel.<parallelNodeId>.results` from routing (written by
// the parallel handler in the preceding node), feeds the candidates to
// the pure `foldFanIn` reducer, and publishes the winner back into
// routing under `fan_in.<nodeId>.winner` so downstream codergen/tool
// nodes can reference it via `${context.fan_in.*}` substitution.
//
// The LLM-eval branch from attractor §4.9 (`IF node.prompt is not empty`)
// is still deferred; this handler only runs the heuristic. When it
// lands, the emit side belongs in a separate handler kind or a
// `prompt`-branching switch inside this one.

import { type FanInCandidate, foldFanIn } from "../../engine/fan-in.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export interface FanInHandlerConfig {
  /** Id of the `parallel` node whose results we consume. The parallel
   * handler writes to `parallel.<parallelNodeId>.results`, which this
   * handler reads back. */
  parallelNodeId: string;
  /** When set, short-circuits edge selection. Leave unset to defer to
   * the executor's 5-rule priority on outgoing unconditional edges. */
  nextNode?: string;
  /** Hard timeout. 1 second is plenty — this is a pure reducer wrapped
   * as a handler, no I/O. */
  maxMs?: number;
}

const DEFAULT_MAX_MS = 1_000;

export function makeFanInHandler(cfg: FanInHandlerConfig): HandlerSpec {
  const handler: Handler = async (ctx) => {
    const resultsKey = `parallel.${cfg.parallelNodeId}.results`;
    const raw = ctx.routing[resultsKey];
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        kind: "halt",
        reason: "error",
        detail: `fan_in "${ctx.nodeId}": no results under routing.${resultsKey}`,
      } satisfies HandlerResult;
    }

    const candidates: FanInCandidate[] = [];
    for (const r of raw) {
      if (r == null || typeof r !== "object") continue;
      const branchId = (r as { branchId?: unknown }).branchId;
      const status = (r as { status?: unknown }).status;
      if (typeof branchId !== "string" || typeof status !== "string") continue;
      const score = (r as { score?: unknown }).score;
      const cand: FanInCandidate = { branchId, status: status as FanInCandidate["status"] };
      if (typeof score === "number") cand.score = score;
      candidates.push(cand);
    }

    const { winner, ranked, allFailed } = foldFanIn(candidates);
    const outcomeStatus: "success" | "fail" = allFailed ? "fail" : "success";

    ctx.emit("fan_in.completed", {
      fanInNodeId: ctx.nodeId,
      parallelNodeId: cfg.parallelNodeId,
      winner: winner?.branchId ?? null,
      allFailed,
      rankedOrder: ranked.map((r) => r.branchId),
    });

    const winnerKey = `fan_in.${ctx.nodeId}.winner`;
    const allFailedKey = `fan_in.${ctx.nodeId}.all_failed`;
    const result: HandlerResult = {
      kind: "transition",
      outcomeStatus,
      tokens: 0,
      costUsd: 0,
      routingDelta: {
        [winnerKey]: winner?.branchId ?? null,
        [allFailedKey]: allFailed,
      },
    };
    if (cfg.nextNode !== undefined) result.nextNode = cfg.nextNode;
    return result;
  };

  return {
    kind: "parallel.fan_in",
    sideEffect: "none",
    maxMs: cfg.maxMs ?? DEFAULT_MAX_MS,
    handler,
  };
}
