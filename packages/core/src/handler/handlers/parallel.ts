// parallel handler — concurrent sub-execution via first-class sub-runs.
//
// Each fan-out enqueues N child `run_state` rows (one per branch) and
// transitions the parent to `running_children`. The wake-pending sweep
// promotes the parent back to `queued` once every sub-run reaches a
// terminal status; the parent's next dispatch re-enters
// this handler in **collect phase**, builds the `ParallelBranchResult[]`
// from the parent's projection-folded sub-run outcomes, and hands off
// to fan_in.
//
// See `docs/proposals/parallel.md` for the full design.

import { FAN_IN_VERSION, type FanInCandidate } from "../../engine/fan-in.ts";
import type { Handler, HandlerResult, HandlerSpec, SubRunOutcome } from "../types.ts";

export type JoinPolicy = "wait_all" | "first_success";

export interface ParallelConfig {
  /** Ids of the branch nodes — the direct downstream targets of the
   * parallel (component) node in the DOT graph. */
  children: string[];
  /** Id of the fan_in node the parallel handler hands off to when all
   * branches have resolved. */
  fanInNode: string;
  /** Default `wait_all`. `first_success` cancels losing siblings (P4 of
   * the proposal — implemented as `intent.cancel_requested` on every
   * non-winning sub-run; siblings unwind via the normal cancel path). */
  joinPolicy?: JoinPolicy;
  /** Hard timeout for the whole fan-out. Optional: parallel is an
   * orchestration layer, not a deadline in its own right — sub-runs
   * self-police via their own watchdog (P0.2 / D5). Default: effectively
   * unbounded (1 hour). */
  maxMs?: number;
}

export interface ParallelBranchResult {
  branchId: string;
  status: FanInCandidate["status"];
  /** Optional score the branch surfaced via its outcome's `score`. */
  score?: number;
  /** Non-empty when the branch failed / halted. Surfaced in routing so
   * fan_in can emit informative failure reasons. */
  failReason?: string;
}

// Effectively unbounded. Sub-runs' own maxMs is the real fence.
const DEFAULT_MAX_MS = 60 * 60 * 1000;

/**
 * Detect collect phase: the prior dispatch's `fact.fanout_started`
 * stamped sub-run IDs into routing under `parallel.<nodeId>.sub_run_ids`;
 * a second dispatch with the key present means the wake-pending sweep
 * has converged. Pure read — no side effects.
 */
function readSubRunIds(routing: Readonly<Record<string, unknown>>, parentNodeId: string): string[] | null {
  const key = `parallel.${parentNodeId}.sub_run_ids`;
  const raw = routing[key];
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    ids.push(v);
  }
  return ids;
}

/**
 * Map a single sub-run's inline outcome to the legacy
 * `ParallelBranchResult` shape fan_in expects. `branchId` is the branch's
 * **node** id (matched against `cfg.children[parallelIndex]`), NOT the
 * sub-run id — preserves the convention where `$<branchId>.output`
 * substitution resolves through the branch node id.
 */
function mapOutcome(branchNodeId: string, outcome: SubRunOutcome): ParallelBranchResult {
  let status: FanInCandidate["status"];
  switch (outcome.finalStatus) {
    case "completed":
      status = "success";
      break;
    case "halted":
    case "cancelled":
      status = "fail";
      break;
  }
  const out: ParallelBranchResult = { branchId: branchNodeId, status };
  if (outcome.fanInScore !== undefined) out.score = outcome.fanInScore;
  return out;
}

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

    const subRunIds = readSubRunIds(parentCtx.routing, parentCtx.nodeId);

    // Collect phase: prior dispatch committed `fact.fanout_started`, the
    // wake-pending sweep converged sub-runs, and the executor re-entered
    // this handler with sub-run outcomes already folded into
    // `parentCtx.subRunOutcomes`. Synthesise the fan_in input shape and
    // transition to the fan_in node.
    if (subRunIds !== null && subRunIds.length === cfg.children.length) {
      const results: ParallelBranchResult[] = subRunIds.map((subRunId, parallelIndex) => {
        const outcome = parentCtx.subRunOutcomes.get(subRunId);
        const branchNodeId = cfg.children[parallelIndex] ?? subRunId;
        if (outcome === undefined) {
          // Sweep promoted the parent but didn't write a
          // `fact.subrun_completed` for this id. The convergence
          // invariant (sweep emits one per sub-run before
          // `fact.fanout_completed`) is broken — surface as a branch
          // failure rather than silently dropping a slot. The fan_in
          // handler downgrades to `outcome=fail` and routing carries
          // the reason.
          return {
            branchId: branchNodeId,
            status: "fail",
            failReason: `sub-run "${subRunId}" terminated without a fact.subrun_completed payload`,
          };
        }
        return mapOutcome(branchNodeId, outcome);
      });

      return {
        kind: "transition",
        nextNode: cfg.fanInNode,
        outcomeStatus: "success",
        tokens: 0,
        costUsd: 0,
        routingDelta: {
          [`parallel.${parentCtx.nodeId}.results`]: results,
          // Pin the fan-in algorithm version at the moment the parallel
          // node settles. The fan_in handler reads it back so a replay
          // of this parallel after a future ranker bump still sees the
          // ordering this run was designed under.
          [`parallel.${parentCtx.nodeId}.fan_in_version`]: FAN_IN_VERSION,
        },
      } satisfies HandlerResult;
    }

    // Fan-out phase: ask the executor to enqueue N sub-runs and
    // transition us to `running_children`. The executor mints sub-run
    // ids, writes them onto routing, and emits `fact.fanout_started`
    // in a single OCC commit (P2.2 of the proposal).
    return {
      kind: "fanout_pending",
      branchNodeIds: cfg.children,
      fanInNode: cfg.fanInNode,
      joinPolicy,
    } satisfies HandlerResult;
  };

  return {
    kind: "parallel",
    sideEffect: "none",
    maxMs: cfg.maxMs ?? DEFAULT_MAX_MS,
    handler,
  };
}

/** Unused under the sub-run model; kept exported for callers that
 *  may still import it. Future cleanups will drop it once no consumer
 *  references it. */
export function legacyParallelResultMapper(): undefined {
  return undefined;
}

/** Compute the helper context that downstream code may want for a
 *  branch during collect phase. Exposed for tests; not used inside the
 *  handler itself. */
export function buildBranchResultFromOutcome(branchNodeId: string, outcome: SubRunOutcome): ParallelBranchResult {
  return mapOutcome(branchNodeId, outcome);
}
