// Pure-reducer tests for `lib/stats.ts`. No DOM, no router — these
// run in milliseconds because the function under test is just folding
// numbers.
//
// Coverage targets (per the P5.13 plan):
//   - Empty list → all zeros, successRate 0, avgDurationMs absent.
//   - Mixed statuses → counts / cost / tokens sum correctly.
//   - avgDurationMs excludes running runs and is omitted when no
//     terminal runs exist.

import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../src/lib/api.ts";
import { computeStats } from "../../src/lib/stats.ts";

function row(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: overrides.runId ?? "r",
    startedAt: overrides.startedAt ?? "2024-01-01T00:00:00Z",
    status: overrides.status ?? "success",
    eventCount: overrides.eventCount ?? 1,
    costUsd: overrides.costUsd ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    ...(overrides.cacheReadTokens !== undefined ? { cacheReadTokens: overrides.cacheReadTokens } : {}),
    ...(overrides.cacheWriteTokens !== undefined ? { cacheWriteTokens: overrides.cacheWriteTokens } : {}),
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.workflow !== undefined ? { workflow: overrides.workflow } : {}),
    ...(overrides.workflowName !== undefined ? { workflowName: overrides.workflowName } : {}),
  };
}

describe("computeStats", () => {
  it("returns all-zero tiles for an empty list", () => {
    const s = computeStats([]);
    expect(s.totalRuns).toBe(0);
    expect(s.queued).toBe(0);
    expect(s.running).toBe(0);
    expect(s.paused).toBe(0);
    expect(s.succeeded).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.canceled).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.billedTokens).toBe(0);
    expect(s.totalCacheReadTokens).toBe(0);
    expect(s.totalCacheWriteTokens).toBe(0);
    expect(s.cacheHitRate).toBeUndefined();
    expect(s.avgDurationMs).toBeUndefined();
  });

  it("counts runs by status", () => {
    const s = computeStats([
      row({ runId: "a", status: "running" }),
      row({ runId: "b", status: "success", durationMs: 10_000 }),
      row({ runId: "c", status: "fail", durationMs: 20_000 }),
      row({ runId: "d", status: "success", durationMs: 30_000 }),
      row({ runId: "e", status: "unknown" }),
      row({ runId: "f", status: "canceled", durationMs: 5_000 }),
      row({ runId: "g", status: "queued" }),
      row({ runId: "h", status: "queued" }),
      row({ runId: "i", status: "paused" }),
    ]);
    expect(s.totalRuns).toBe(9);
    expect(s.queued).toBe(2);
    expect(s.running).toBe(1);
    expect(s.paused).toBe(1);
    expect(s.succeeded).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.canceled).toBe(1);
  });

  it("queued and paused runs are excluded from successRate and avgDurationMs", () => {
    const s = computeStats([
      row({ runId: "a", status: "success", durationMs: 10_000 }),
      row({ runId: "b", status: "fail", durationMs: 20_000 }),
      row({ runId: "c", status: "queued" }),
      row({ runId: "d", status: "paused" }),
    ]);
    // Only success + fail count toward successRate / avgDurationMs.
    expect(s.successRate).toBeCloseTo(0.5, 6);
    expect(s.avgDurationMs).toBe(15_000);
  });

  it("excludes canceled runs from successRate and avgDurationMs", () => {
    const s = computeStats([
      row({ runId: "a", status: "success", durationMs: 10_000 }),
      row({ runId: "b", status: "fail", durationMs: 20_000 }),
      // Canceled: shouldn't enter either numerator or denominator.
      row({ runId: "c", status: "canceled", durationMs: 500 }),
    ]);
    expect(s.successRate).toBeCloseTo(0.5, 6);
    expect(s.avgDurationMs).toBe(15_000);
    expect(s.canceled).toBe(1);
  });

  it("computes successRate over terminal runs only", () => {
    const s = computeStats([
      row({ runId: "a", status: "success", durationMs: 1 }),
      row({ runId: "b", status: "success", durationMs: 1 }),
      row({ runId: "c", status: "success", durationMs: 1 }),
      row({ runId: "d", status: "fail", durationMs: 1 }),
      row({ runId: "e", status: "running" }),
    ]);
    // 3 of 4 terminal runs succeeded → 0.75. Running runs don't count.
    expect(s.successRate).toBeCloseTo(0.75, 6);
  });

  it("returns 0 for successRate when no terminal runs exist", () => {
    const s = computeStats([row({ runId: "a", status: "running" }), row({ runId: "b", status: "running" })]);
    expect(s.successRate).toBe(0);
  });

  it("sums cost and tokens across every input row", () => {
    const s = computeStats([
      row({ runId: "a", costUsd: 0.1, inputTokens: 100, outputTokens: 50 }),
      row({ runId: "b", costUsd: 0.05, inputTokens: 200, outputTokens: 25 }),
      row({ runId: "c", costUsd: 0.02, inputTokens: 50, outputTokens: 10 }),
    ]);
    expect(s.totalCostUsd).toBeCloseTo(0.17, 6);
    expect(s.billedTokens).toBe(100 + 50 + 200 + 25 + 50 + 10);
  });

  it("billedTokens sums input + output + cacheRead + cacheWrite", () => {
    // Regression guard for the headline-tile undercount: a cache-warm
    // run's billed total must include cache_read + cache_write, not
    // just fresh input/output. Cache-hit-rate denominator is unchanged
    // (commit 0dab015) — only the headline tokens number widens.
    const s = computeStats([
      row({ runId: "a", inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 500 }),
    ]);
    expect(s.billedTokens).toBe(1650);
    // hit-rate denominator: input + cacheRead + cacheWrite = 1600.
    expect(s.cacheHitRate).toBeCloseTo(1000 / 1600, 6);
  });

  it("avgDurationMs averages terminal runs only and excludes running ones", () => {
    const s = computeStats([
      row({ runId: "a", status: "success", durationMs: 10_000 }),
      row({ runId: "b", status: "fail", durationMs: 20_000 }),
      // Running run with a "duration so far" must NOT pull the average.
      row({ runId: "c", status: "running", durationMs: 999_999 }),
    ]);
    expect(s.avgDurationMs).toBe(15_000);
  });

  it("sums cache tokens and computes hit rate as reads / (input + reads + writes)", () => {
    const s = computeStats([
      row({ runId: "a", inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 50 }),
      row({ runId: "b", inputTokens: 200, cacheReadTokens: 100 }),
    ]);
    expect(s.totalCacheReadTokens).toBe(400);
    expect(s.totalCacheWriteTokens).toBe(50);
    // (300 + 100) / ((100 + 200) + (300 + 100) + (50 + 0)) = 400 / 750
    // cacheWrite is in the denominator so a warm thread doesn't asymptote
    // at 100% — it reflects the prompt-token cost of writing the cache.
    expect(s.cacheHitRate).toBeCloseTo(400 / 750, 6);
  });

  it("cacheHitRate is undefined when no input or cache-read tokens were seen", () => {
    const s = computeStats([row({ runId: "a", status: "running" })]);
    expect(s.cacheHitRate).toBeUndefined();
  });

  it("avgDurationMs is omitted when no terminal run carries a duration", () => {
    const s = computeStats([
      row({ runId: "a", status: "running" }),
      // Terminal but no durationMs — the run was too short to measure.
      row({ runId: "b", status: "success" }),
    ]);
    expect(s.avgDurationMs).toBeUndefined();
  });
});
