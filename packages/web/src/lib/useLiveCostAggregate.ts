// Pure reducer + React hook for folding SSE event frames into a live
// cost / token / cache-hit aggregate for the run-detail header.
//
// `reduceCostEvents` is a pure function so it can be tested without a DOM.
// `useLiveCostAggregate` is a thin `useMemo` wrapper consumed by RunDetail.
//
// Only `cost.recorded` events are folded — all other event types are
// ignored. Payload field extraction is defensive (non-number → 0) so
// the reducer never NaNs on partial or future-shaped payloads.

import { useMemo } from "react";

/** Parsed SSE frame shape — the minimal slice `useRunLive` accumulates. */
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

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Pure reducer: fold an array of SSE frames into a `CostAggregate`.
 * Non-`cost.recorded` events are skipped; missing payload fields default
 * to 0 so the result is always a valid number (never NaN).
 */
export function reduceCostEvents(events: ReadonlyArray<LiveEvent>): CostAggregate {
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;

  for (const ev of events) {
    if (ev.type !== "cost.recorded") continue;
    const p = ev.payload ?? {};
    totalCostUsd += asNum(p["cost_usd"]);
    totalInputTokens += asNum(p["input_tokens"]);
    totalOutputTokens += asNum(p["output_tokens"]);
    totalCacheReadTokens += asNum(p["cache_read_tokens"]);
    totalCacheWriteTokens += asNum(p["cache_write_tokens"]);
  }

  const readDenom = totalInputTokens + totalCacheReadTokens;
  const cacheHitRate = readDenom > 0 ? totalCacheReadTokens / readDenom : undefined;

  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    cacheHitRate,
  };
}

/**
 * Memoised hook: re-folds `events` only when the array reference
 * changes. Pass the `liveEvents` slice from `useRunLive`.
 */
export function useLiveCostAggregate(events: ReadonlyArray<LiveEvent>): CostAggregate {
  return useMemo(() => reduceCostEvents(events), [events]);
}
