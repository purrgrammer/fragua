// Fan-in reducer — attractor-spec §4.9, heuristic branch.
//
// Consolidates N parallel branch outcomes into a single winner. Pure: no
// I/O, no mutation of inputs. The LLM-eval branch (`IF node.prompt is not
// empty`) is deferred; this module implements the `ELSE` clause:
//
//   SORT candidates BY (outcome_rank, -score, branchId)
//   outcome_rank = {success: 0, partial_success: 1, retry: 2, skipped: 3, fail: 4}
//
// `skipped` is a swarm-specific status (attractor has only the four); we
// rank it between retry and fail because a node that skipped produced no
// work but also didn't error, which is strictly worse than a retry-eligible
// outcome and strictly better than a hard failure.
//
// Fan-in returns `allFailed` so the caller can map to Outcome.status: the
// spec says fan-in only returns FAIL when every candidate failed; otherwise
// the best non-fail candidate is the winner.

import type { OutcomeStatus } from "../types/outcome.ts";

export interface FanInCandidate {
  /** Stable identifier for deterministic lexical tiebreak. */
  branchId: string;
  status: OutcomeStatus;
  /** Higher is better. Defaults to 0 when unset. Attractor §4.9 sorts
   * candidates descending by this field after the status rank. */
  score?: number;
}

export interface FanInResult {
  /** Ranked best→worst; `ranked[0]` is the winner. `null` only when the
   * input was empty. */
  winner: FanInCandidate | null;
  /** Stable ordering under any permutation of the input. Length always
   * matches the input length. */
  ranked: FanInCandidate[];
  /** True iff the input is non-empty and every candidate has status="fail".
   * Per attractor §4.9 this is the only case where fan-in itself should
   * return FAIL to the executor; otherwise the winner is always usable. */
  allFailed: boolean;
}

const OUTCOME_RANK: Record<OutcomeStatus, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  skipped: 3,
  fail: 4,
};

export function foldFanIn(candidates: readonly FanInCandidate[]): FanInResult {
  const ranked = [...candidates].sort(compareCandidates);
  const allFailed = candidates.length > 0 && candidates.every((c) => c.status === "fail");
  return {
    winner: ranked[0] ?? null,
    ranked,
    allFailed,
  };
}

function compareCandidates(a: FanInCandidate, b: FanInCandidate): number {
  const ra = OUTCOME_RANK[a.status];
  const rb = OUTCOME_RANK[b.status];
  if (ra !== rb) return ra - rb;
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sa !== sb) return sb - sa;
  return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
}
