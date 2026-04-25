// Pure-reducer tests for `lib/useLiveCostAggregate.ts`.
// No DOM, no React — these are plain function calls.

import { describe, expect, test } from "bun:test";
import type { LiveEvent } from "../../src/lib/useLiveCostAggregate.ts";
import { reduceCostEvents } from "../../src/lib/useLiveCostAggregate.ts";

function costEvent(
  cost_usd: number,
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
): LiveEvent {
  return {
    type: "cost.recorded",
    payload: { cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens },
  };
}

function otherEvent(type = "fact.node_started"): LiveEvent {
  return { type, payload: { nodeId: "n1", iteration: 0 } };
}

describe("reduceCostEvents", () => {
  test("returns zero aggregate for empty events array", () => {
    const agg = reduceCostEvents([]);
    expect(agg.totalCostUsd).toBe(0);
    expect(agg.totalInputTokens).toBe(0);
    expect(agg.totalOutputTokens).toBe(0);
    expect(agg.totalCacheReadTokens).toBe(0);
    expect(agg.totalCacheWriteTokens).toBe(0);
    expect(agg.cacheHitRate).toBeUndefined();
  });

  test("folds cost.recorded events, ignoring non-cost events", () => {
    const events: LiveEvent[] = [
      otherEvent("fact.run_started"),
      costEvent(0.05, 500, 100, 0, 0),
      otherEvent("llm.text_delta"),
      costEvent(0.03, 300, 80, 0, 0),
      otherEvent("agent.message_end"),
    ];
    const agg = reduceCostEvents(events);
    expect(agg.totalCostUsd).toBeCloseTo(0.08, 6);
    expect(agg.totalInputTokens).toBe(800);
    expect(agg.totalOutputTokens).toBe(180);
    expect(agg.totalCacheReadTokens).toBe(0);
    expect(agg.totalCacheWriteTokens).toBe(0);
  });

  test("computes cacheHitRate as cacheReadTokens / (inputTokens + cacheReadTokens)", () => {
    const events: LiveEvent[] = [costEvent(0.01, 200, 50, 100, 0)];
    const agg = reduceCostEvents(events);
    // cacheReadTokens=100, inputTokens=200 → 100 / (200 + 100) = 100/300
    expect(agg.cacheHitRate).toBeCloseTo(100 / 300, 6);
  });

  test("cacheHitRate is undefined when no input or cache-read tokens are seen", () => {
    const events: LiveEvent[] = [
      {
        type: "cost.recorded",
        payload: { cost_usd: 0.001, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      },
    ];
    const agg = reduceCostEvents(events);
    expect(agg.cacheHitRate).toBeUndefined();
  });

  test("live aggregate from SSE events agrees with snapshot values at terminal fact", () => {
    // Simulate three cost.recorded events that together match known snapshot totals.
    const events: LiveEvent[] = [
      costEvent(0.1, 1000, 200, 300, 50),
      costEvent(0.05, 500, 100, 150, 25),
      costEvent(0.02, 200, 50, 50, 10),
    ];
    const agg = reduceCostEvents(events);

    // These are the expected "snapshot" values the server would return.
    const snapshotCostUsd = 0.17;
    const snapshotInputTokens = 1700;
    const snapshotOutputTokens = 350;
    const snapshotCacheReadTokens = 500;
    const snapshotCacheWriteTokens = 85;

    expect(agg.totalCostUsd).toBeCloseTo(snapshotCostUsd, 6);
    expect(agg.totalInputTokens).toBe(snapshotInputTokens);
    expect(agg.totalOutputTokens).toBe(snapshotOutputTokens);
    expect(agg.totalCacheReadTokens).toBe(snapshotCacheReadTokens);
    expect(agg.totalCacheWriteTokens).toBe(snapshotCacheWriteTokens);
  });
});
