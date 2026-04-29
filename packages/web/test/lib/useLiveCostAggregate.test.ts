// Pure-aggregator tests for `lib/useLiveCostAggregate.ts`.
// No DOM, no React — these are plain function calls.

import { describe, expect, test } from "bun:test";
import {
  aggregateLiveFrames,
  EMPTY_COST_AGGREGATE,
  frameFromPayload,
  type LiveCostFrame,
} from "../../src/lib/useLiveCostAggregate.ts";

function frame(
  seq: number,
  cost_usd: number,
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
): LiveCostFrame {
  return frameFromPayload(seq, {
    cost_usd,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens,
  });
}

describe("frameFromPayload", () => {
  test("extracts every numeric field, defaulting non-numbers to 0", () => {
    const f = frameFromPayload(7, {
      cost_usd: 0.12,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 50,
      cache_write_tokens: 10,
    });
    expect(f).toEqual({
      seq: 7,
      costUsd: 0.12,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
  });

  test("ignores non-numeric payload fields without NaN-ing", () => {
    const f = frameFromPayload(1, {
      cost_usd: "nope" as unknown as number,
      input_tokens: null as unknown as number,
      output_tokens: undefined as unknown as number,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    expect(f).toEqual({
      seq: 1,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("preserves the seq even when payload fields are absent", () => {
    const f = frameFromPayload(42, {});
    expect(f.seq).toBe(42);
    expect(f.costUsd).toBe(0);
  });
});

describe("aggregateLiveFrames", () => {
  test("returns an empty aggregate for an empty frames array", () => {
    expect(aggregateLiveFrames([], 0)).toEqual(EMPTY_COST_AGGREGATE);
  });

  test("with cutoff=0 sums every frame", () => {
    const frames = [frame(1, 0.05, 500, 100), frame(2, 0.03, 300, 80)];
    const agg = aggregateLiveFrames(frames, 0);
    expect(agg.totalCostUsd).toBeCloseTo(0.08, 6);
    expect(agg.totalInputTokens).toBe(800);
    expect(agg.totalOutputTokens).toBe(180);
  });

  test("frames at seq ≤ cutoff are filtered out (disjoint with snapshot)", () => {
    // The snapshot's server-side SQL aggregate already covers events
    // up to its lastEventSeq watermark. Frames whose seq is at or below
    // that watermark are filtered out so the consumer can add the
    // snapshot total to the live delta without double-counting.
    const frames = [frame(101, 0.05, 500, 100), frame(102, 0.05, 500, 100)];
    const agg = aggregateLiveFrames(frames, 200);
    expect(agg).toEqual(EMPTY_COST_AGGREGATE);
  });

  test("partial cutoff: only frames strictly past cutoff count", () => {
    const frames = [frame(100, 0.1, 1000, 200), frame(101, 0.05, 500, 100), frame(102, 0.02, 200, 50)];
    const agg = aggregateLiveFrames(frames, 100);
    expect(agg.totalCostUsd).toBeCloseTo(0.07, 6);
    expect(agg.totalInputTokens).toBe(700);
    expect(agg.totalOutputTokens).toBe(150);
  });

  test("computes cacheHitRate as cacheReadTokens / (inputTokens + cacheReadTokens)", () => {
    const frames = [frame(1, 0.01, 200, 50, 100, 0)];
    const agg = aggregateLiveFrames(frames, 0);
    // cacheReadTokens=100, inputTokens=200 → 100 / (200 + 100)
    expect(agg.cacheHitRate).toBeCloseTo(100 / 300, 6);
  });

  test("cacheHitRate is undefined when no input or cache-read tokens are seen", () => {
    const frames = [frame(1, 0.001, 0, 0, 0, 0)];
    const agg = aggregateLiveFrames(frames, 0);
    expect(agg.cacheHitRate).toBeUndefined();
  });

  test("EMPTY_COST_AGGREGATE matches aggregateLiveFrames([], 0)", () => {
    expect(EMPTY_COST_AGGREGATE).toEqual(aggregateLiveFrames([], 0));
  });

  test("matches the live + snapshot invariant: snapshot.costUsd + delta = full sum", () => {
    // Three frames totaling $0.17. If the snapshot covers seqs 1-2
    // ($0.15), the delta over cutoff=2 must be $0.02 — together they
    // recover the full sum without double-counting the overlap.
    const frames = [
      frame(1, 0.1, 1000, 200, 300, 50),
      frame(2, 0.05, 500, 100, 150, 25),
      frame(3, 0.02, 200, 50, 50, 10),
    ];
    const fullSum = aggregateLiveFrames(frames, 0);
    const delta = aggregateLiveFrames(frames, 2);
    const snapshotCost = 0.15;
    const snapshotInput = 1500;
    const snapshotOutput = 300;
    expect(snapshotCost + delta.totalCostUsd).toBeCloseTo(fullSum.totalCostUsd, 6);
    expect(snapshotInput + delta.totalInputTokens).toBe(fullSum.totalInputTokens);
    expect(snapshotOutput + delta.totalOutputTokens).toBe(fullSum.totalOutputTokens);
  });
});
