// Incremental + bulk reducers for folding `cost.recorded` SSE frames
// into a live cost / token / cache-hit aggregate.
//
// `foldCostFrame` runs in O(1) per frame and is what `useRunLive` calls
// on each SSE event — the running aggregate is what the UI consumes.
// `reduceCostEvents` is a thin bulk wrapper kept for tests + ad-hoc
// recomputation from a known event list.
//
// Only `cost.recorded` events are folded. Payload field extraction is
// defensive (non-number → 0) so the reducer never NaNs on partial or
// future-shaped payloads.

/** Parsed SSE frame shape — the minimal slice `useRunLive` once
 * accumulated. Kept for the bulk `reduceCostEvents` helper that takes
 * a ready-made event list. */
export interface LiveEvent {
  type: string;
  payload: Record<string, unknown> | null;
}

/** Live aggregate produced by folding a run's SSE event stream. */
export interface CostAggregate {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /**
   * `totalCacheReadTokens / (totalInputTokens + totalCacheReadTokens)`.
   * `undefined` when the denominator is zero (no tokens seen yet).
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

/** Add a single `cost.recorded` payload onto an existing aggregate.
 * Returns a new object — safe to use as a `setState` updater. */
export function foldCostFrame(prev: CostAggregate, payload: Record<string, unknown>): CostAggregate {
  const totalInputTokens = prev.totalInputTokens + asNum(payload["input_tokens"]);
  const totalCacheReadTokens = prev.totalCacheReadTokens + asNum(payload["cache_read_tokens"]);
  const readDenom = totalInputTokens + totalCacheReadTokens;
  return {
    totalCostUsd: prev.totalCostUsd + asNum(payload["cost_usd"]),
    totalInputTokens,
    totalOutputTokens: prev.totalOutputTokens + asNum(payload["output_tokens"]),
    totalCacheReadTokens,
    totalCacheWriteTokens: prev.totalCacheWriteTokens + asNum(payload["cache_write_tokens"]),
    cacheHitRate: readDenom > 0 ? totalCacheReadTokens / readDenom : undefined,
  };
}

/** Bulk fold — kept for tests and ad-hoc recomputation. Equivalent to
 * threading `foldCostFrame` over every `cost.recorded` event. */
export function reduceCostEvents(events: ReadonlyArray<LiveEvent>): CostAggregate {
  let agg: CostAggregate = EMPTY_COST_AGGREGATE;
  for (const ev of events) {
    if (ev.type !== "cost.recorded") continue;
    agg = foldCostFrame(agg, ev.payload ?? {});
  }
  return agg;
}
