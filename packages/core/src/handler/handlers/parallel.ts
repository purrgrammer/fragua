// parallel handler — attractor-spec §4.8 concurrent sub-execution.
//
// Regime C (deliberation-only): each branch runs in-process with a
// deep-cloned routing snapshot. Branches DO NOT mutate the worktree —
// enforced by convention (workflows restrict branch `allowed_tools` to
// read-only sets). The parent run's single worktree is preserved across
// the fan-out / fan-in, so we avoid attractor's in-memory-only semantics
// losing swarm's per-run filesystem isolation.
//
// Branch outcomes are collected into routing under the key
//   `parallel.<parallelNodeId>.results = [{branchId, status, score?}, ...]`
// — the downstream `parallel.fan_in` handler reads this and runs
// `foldFanIn` to pick a winner.
//
// Limitations (v1):
//   - A branch that returns `yield_hitl` is coerced to `fail` with a
//     documented reason. Nested HITL in a parallel fan-out is not
//     supported by the current turn-based executor.
//   - External-call intent/done facts emitted from a branch attribute
//     to the parent parallel node's nodeId (inherited externalCall).
//     For MVP this is fine because branches are deliberation-only and
//     rarely touch externalCall; can be refined when a concrete need
//     surfaces.
//   - `first_success` join policy cancels losing branches best-effort
//     by triggering the shared AbortController. Branches that don't
//     respect the signal keep running until completion.

import type { FanInCandidate } from "../../engine/fan-in.ts";
import type { Handler, HandlerContext, HandlerResult, HandlerSpec } from "../types.ts";

export type JoinPolicy = "wait_all" | "first_success";

export interface ParallelConfig {
  /** Ids of the branch nodes — the direct downstream targets of the
   * parallel (component) node in the DOT graph. */
  children: string[];
  /** Id of the fan_in node the parallel handler hands off to when all
   * branches have resolved (or the winner arrives, under first_success). */
  fanInNode: string;
  /** Per attractor §4.8. Defaults to `wait_all`. */
  joinPolicy?: JoinPolicy;
  /** Look up the HandlerSpec for a branch by its node id. Typically
   * closes over the auto-dispatcher's specs map. Returning null halts
   * the parallel node — a branch must resolve or the graph is wrong. */
  resolveChild: (nodeId: string) => HandlerSpec | null;
  /** Build the per-branch HandlerContext. The executor-facing factory
   * typically deep-clones routing and overrides nodeId + iteration;
   * this lets tests stub out context construction cheaply. */
  buildChildContext: (nodeId: string, parentCtx: HandlerContext) => HandlerContext;
  /** Hard timeout for the whole fan-out. Default 10 minutes. */
  maxMs?: number;
}

export interface ParallelBranchResult {
  branchId: string;
  status: FanInCandidate["status"];
  /** Optional score surfaced by the branch in `routingDelta["score"]`. */
  score?: number;
  /** Non-empty when the branch failed / halted — surfaced in routing so
   * fan_in can emit informative failure reasons. */
  failReason?: string;
}

const DEFAULT_MAX_MS = 10 * 60 * 1000;

export function makeParallelHandler(cfg: ParallelConfig): HandlerSpec {
  const joinPolicy: JoinPolicy = cfg.joinPolicy ?? "wait_all";

  const handler: Handler = async (parentCtx) => {
    if (cfg.children.length === 0) {
      return {
        kind: "halt",
        reason: "error",
        detail: `parallel node "${parentCtx.nodeId}" has no branches`,
      } satisfies HandlerResult;
    }

    const branchAbort = new AbortController();
    const branches: Promise<ParallelBranchResult>[] = cfg.children.map(
      async (childId): Promise<ParallelBranchResult> => {
        const childSpec = cfg.resolveChild(childId);
        if (childSpec == null) {
          return {
            branchId: childId,
            status: "fail",
            failReason: `branch "${childId}" has no dispatchable HandlerSpec`,
          };
        }
        const childCtx = cfg.buildChildContext(childId, parentCtx);
        try {
          const result = await childSpec.handler(childCtx);
          return mapResult(childId, result);
        } catch (err) {
          return {
            branchId: childId,
            status: "fail",
            failReason: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );

    const results =
      joinPolicy === "first_success" ? await raceForFirstSuccess(branches, branchAbort) : await Promise.all(branches);

    parentCtx.emit("parallel.completed", {
      parallelNodeId: parentCtx.nodeId,
      joinPolicy,
      branches: results.map((r) => ({ branchId: r.branchId, status: r.status })),
    });

    return {
      kind: "transition",
      nextNode: cfg.fanInNode,
      outcomeStatus: "success",
      tokens: 0,
      costUsd: 0,
      routingDelta: {
        [`parallel.${parentCtx.nodeId}.results`]: results,
      },
    } satisfies HandlerResult;
  };

  return {
    kind: "parallel",
    sideEffect: "none",
    maxMs: cfg.maxMs ?? DEFAULT_MAX_MS,
    handler,
  };
}

function mapResult(branchId: string, result: HandlerResult): ParallelBranchResult {
  if (result.kind === "transition") {
    const status = result.outcomeStatus ?? "success";
    const score =
      typeof result.routingDelta?.["score"] === "number" ? (result.routingDelta["score"] as number) : undefined;
    const out: ParallelBranchResult = { branchId, status };
    if (score !== undefined) out.score = score;
    return out;
  }
  if (result.kind === "halt") {
    return {
      branchId,
      status: "fail",
      failReason: result.detail ?? `branch halted: ${result.reason}`,
    };
  }
  // yield_hitl — not supported inside a parallel branch under v1.
  return {
    branchId,
    status: "fail",
    failReason: "branch returned yield_hitl; HITL inside parallel not supported in v1",
  };
}

/**
 * Resolve as soon as one branch returns `success`, aborting the rest.
 * If all branches resolve without success, return every result (same
 * shape as `wait_all`) so fan_in can still rank them.
 */
async function raceForFirstSuccess(
  branches: Promise<ParallelBranchResult>[],
  abort: AbortController,
): Promise<ParallelBranchResult[]> {
  const pending = new Map<Promise<ParallelBranchResult>, number>();
  branches.forEach((p, i) => pending.set(p, i));
  const results: ParallelBranchResult[] = new Array(branches.length);

  while (pending.size > 0) {
    const racers = Array.from(pending.keys()).map((p) => p.then((r) => ({ p, r })));
    const next = await Promise.race(racers);
    results[pending.get(next.p)!] = next.r;
    pending.delete(next.p);
    if (next.r.status === "success") {
      abort.abort();
      // Drain remaining promises so downstream code never leaks rejections.
      for (const [p, i] of pending) {
        try {
          results[i] = await p;
        } catch (err) {
          results[i] = {
            branchId: `drained_${i}`,
            status: "fail" as const,
            failReason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      break;
    }
  }
  return results;
}
