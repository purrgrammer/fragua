import { describe, expect, test } from "bun:test";
import type { RunSummaryRow } from "@fragua/store";
import { runSummaryRowToSummary } from "../../src/read-plane/projections.ts";

function baseRow(overrides: Partial<RunSummaryRow> = {}): RunSummaryRow {
  return {
    runId: "run-1",
    workflowSha: "abc",
    workflowName: null,
    status: "completed",
    routing: "{}",
    title: null,
    eventTitle: null,
    cwd: "/repos/proj",
    projectId: "p1",
    projectName: "proj",
    enqueuedAt: 1_000_000,
    firstEventTs: 1_000_000,
    lastEventTs: 1_001_000,
    eventCount: 5,
    totalCostUsd: 0.01,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    inboxStatus: null,
    changeStat: null,
    baseGitRef: null,
    baseGitSha: null,
    imported: 0,
    ...overrides,
  };
}

describe("runSummaryRowToSummary — imported flag", () => {
  test("threads imported:true onto the summary when row.imported === 1", () => {
    const summary = runSummaryRowToSummary(baseRow({ imported: 1 }));
    expect(summary.imported).toBe(true);
  });

  test("omits imported when row.imported === 0 (Type.Optional — field absent)", () => {
    const summary = runSummaryRowToSummary(baseRow({ imported: 0 }));
    expect(summary.imported).toBeUndefined();
  });
});
