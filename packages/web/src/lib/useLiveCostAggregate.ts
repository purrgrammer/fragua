// Per-seq cost frame log + cutoff aggregator for live cost / token /
// cache-hit totals.
//
// Each `cost.recorded` SSE frame is captured as a `LiveCostFrame` tagged
// with its store-side `seq`. `aggregateLiveFrames(frames, cutoffSeq)`
// sums only frames with `seq > cutoffSeq` — the consumer passes the
// snapshot's `lastEventSeq` so frames the server-side SQL aggregate
// already covers are filtered out, keeping the two sources disjoint by
// construction. When the snapshot refetches and `lastEventSeq`
// advances, frames that fall under the new watermark drop out of the
// aggregate automatically — `snapshot.costUsd + liveCost.totalCostUsd`
// is the run's true total at all times.
//
// Only `cost.recorded` events are folded. Payload field extraction is
// defensive (non-number → 0) so the aggregator never NaNs on partial
// or future-shaped payloads.

import { cacheHitRate } from "./cache-hit-rate.ts";

/** A single `cost.recorded` payload tagged with its event seq. The seq
 * lets `aggregateLiveFrames` drop frames the snapshot already covered
 * once it advances. */
export interface LiveCostFrame {
  seq: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Live aggregate of frames not yet covered by the server snapshot. */
export interface CostAggregate {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /**
   * `totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens +
   * totalCacheWriteTokens)` — see `lib/cache-hit-rate.ts` for why writes are
   * in the denominator. `undefined` when the denominator is zero (no tokens
   * seen yet).
   */
  cacheHitRate: number | undefined;
}

export const EMPTY_COST_AGGREGATE: CostAggregate = {
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  cacheHitRate: undefined,
};

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Build a `LiveCostFrame` from a `cost.recorded` payload. Defensive on
 * field types — non-numeric inputs land as 0 instead of NaN-ing through
 * the aggregator. */
export function frameFromPayload(seq: number, payload: Record<string, unknown>): LiveCostFrame {
  return {
    seq,
    costUsd: asNum(payload["cost_usd"]),
    inputTokens: asNum(payload["input_tokens"]),
    outputTokens: asNum(payload["output_tokens"]),
    cacheReadTokens: asNum(payload["cache_read_tokens"]),
    cacheWriteTokens: asNum(payload["cache_write_tokens"]),
  };
}

/** Sum `frames` whose `seq` strictly exceeds `cutoffSeq` into a
 * `CostAggregate`. The cutoff is the snapshot's `lastEventSeq` — any
 * frame the snapshot already accounts for is filtered out, so adding
 * the snapshot's server-side total to this aggregate's total never
 * double-counts.
 *
 * Pass `cutoffSeq: 0` to fold every frame (bulk-replay semantics). */
export function aggregateLiveFrames(frames: ReadonlyArray<LiveCostFrame>, cutoffSeq: number): CostAggregate {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  for (const f of frames) {
    if (f.seq <= cutoffSeq) continue;
    totalCostUsd += f.costUsd;
    totalInputTokens += f.inputTokens;
    totalOutputTokens += f.outputTokens;
    totalCacheReadTokens += f.cacheReadTokens;
    totalCacheWriteTokens += f.cacheWriteTokens;
  }
  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    // See lib/cache-hit-rate.ts for what this counts and why.
    cacheHitRate: cacheHitRate({
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens,
    }),
  };
}
