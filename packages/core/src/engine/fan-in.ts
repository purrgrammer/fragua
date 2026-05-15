// Fan-in reducer.
//
// Consolidates N parallel branch outcomes into a single winner. Pure: no
// I/O, no mutation of inputs. fan_in is structural-only — it picks a
// winner via a deterministic heuristic:
//
//   SORT candidates BY (outcome_rank, -score, branchId)
//   outcome_rank = {success: 0, partial_success: 1, retry: 2, skipped: 3, fail: 4}
//
// LLM synthesis of branch outputs is expressed as a downstream codergen
// node referencing `$<branchId>.output`, not as a mode of this handler.
// See `handlers/fan-in.ts` header for the rationale and patterns.
//
// Fan-in returns `allFailed` so the caller can map to Outcome.status: it
// only returns FAIL when every candidate failed; otherwise the best
// non-fail candidate is the winner.
//
// ─── Replay determinism ────────────────────────────────────────────────
//
// `FAN_IN_VERSION` pins the algorithm at the moment a parallel run
// starts. The parallel handler stamps `parallel.<id>.fan_in_version`
// into routing alongside `parallel.<id>.results`; the fan_in handler
// reads both back and feeds the version into `foldFanIn`. If a future
// change reorders OUTCOME_RANK or alters tiebreaks, bump the version
// AND keep the old branch — replays of old runs read their pinned
// version and stay deterministic. Removing an old version branch is a
// breaking schema change (bump CURRENT_SCHEMA_VERSION above MIN).
//
// Mismatch (version > known) throws `FanInVersionMismatchError`; the
// handler maps that to a clean `halt`. Mismatch (version unknown to
// the caller, undefined / 0) defaults to v1 — pre-versioned runs.

import type { OutcomeStatus } from "../types/outcome.ts";

/** Current fan-in algorithm version. Bump when the ranking changes. */
export const FAN_IN_VERSION = 1;

export class FanInVersionMismatchError extends Error {
  constructor(
    public readonly requested: number,
    public readonly known: readonly number[],
  ) {
    super(`fan-in version ${requested} not implemented (known: ${known.join(", ")})`);
    this.name = "FanInVersionMismatchError";
  }
}

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

const OUTCOME_RANK_V1: Record<OutcomeStatus, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  skipped: 3,
  fail: 4,
};

const KNOWN_VERSIONS: readonly number[] = [1];

/**
 * Reduce N branch candidates to a winner under the given algorithm
 * version. `version` defaults to the current implementation; pre-
 * versioned callers (or `undefined`) pin to v1, the only version that
 * existed before pinning. Replay of an old run passes its recorded
 * version so the ranking stays byte-identical even after the algorithm
 * is bumped.
 */
export function foldFanIn(candidates: readonly FanInCandidate[], version: number = FAN_IN_VERSION): FanInResult {
  const v = version || 1; // 0 / NaN / undefined-coerced → pre-pinning runs use v1
  if (!KNOWN_VERSIONS.includes(v)) {
    throw new FanInVersionMismatchError(v, KNOWN_VERSIONS);
  }
  const cmp = v === 1 ? compareCandidatesV1 : compareCandidatesV1;
  const ranked = [...candidates].sort(cmp);
  const allFailed = candidates.length > 0 && candidates.every((c) => c.status === "fail");
  return {
    winner: ranked[0] ?? null,
    ranked,
    allFailed,
  };
}

function compareCandidatesV1(a: FanInCandidate, b: FanInCandidate): number {
  const ra = OUTCOME_RANK_V1[a.status];
  const rb = OUTCOME_RANK_V1[b.status];
  if (ra !== rb) return ra - rb;
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sa !== sb) return sb - sa;
  return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
}
