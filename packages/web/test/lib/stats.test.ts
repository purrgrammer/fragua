// Pure-reducer tests for `lib/stats.ts`. No DOM, no router — these
// run in milliseconds because the function under test is just folding
// numbers.
//
// Coverage targets (per the P5.13 plan):
//   - Empty list → all zeros, successRate 0, avgDurationMs absent.
//   - Mixed statuses → counts / cost / tokens sum correctly.
//   - avgDurationMs excludes running runs and is omitted when no
//     terminal runs exist.

import { describe, expect, it } from "bun:test";
import type { PipelineSummary } from "../../src/lib/api.ts";
import { computeStats } from "../../src/lib/stats.ts";

function row(overrides: Partial<PipelineSummary> = {}): PipelineSummary {
  return {
    runId: overrides.runId ?? "r",
    startedAt: overrides.startedAt ?? "2024-01-01T00:00:00Z",
    status: overrides.status ?? "success",
    eventCount: overrides.eventCount ?? 1,
    costUsd: overrides.costUsd ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    ...(overrides.durationMs !== undefined ? { durationMs: overrides.durationMs } : {}),
    ...(overrides.workflow !== undefined ? { workflow: overrides.workflow } : {}),
    ...(overrides.workflowName !== undefined ? { workflowName: overrides.workflowName } : {}),
  };
}

describe("computeStats", () => {
  it("returns all-zero tiles for an empty list", () => {
    const s = computeStats([]);
    expect(s.totalRuns).toBe(0);
    expect(s.running).toBe(0);
    expect(s.succeeded).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.avgDurationMs).toBeUndefined();
  });

  it("counts runs by status", () => {
    const s = computeStats([
      row({ runId: "a", status: "running" }),
      row({ runId: "b", status: "success", durationMs: 10_000 }),
      row({ runId: "c", status: "fail", durationMs: 20_000 }),
      row({ runId: "d", status: "success", durationMs: 30_000 }),
      row({ runId: "e", status: "unknown" }),
    ]);
    expect(s.totalRuns).toBe(5);
    expect(s.running).toBe(1);
    expect(s.succeeded).toBe(2);
    expect(s.failed).toBe(1);
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
    expect(s.totalTokens).toBe(100 + 50 + 200 + 25 + 50 + 10);
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

  it("avgDurationMs is omitted when no terminal run carries a duration", () => {
    const s = computeStats([
      row({ runId: "a", status: "running" }),
      // Terminal but no durationMs — the run was too short to measure.
      row({ runId: "b", status: "success" }),
    ]);
    expect(s.avgDurationMs).toBeUndefined();
  });
});
