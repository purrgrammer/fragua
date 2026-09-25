import { describe, expect, test } from "bun:test";
import type { RunState, RunSummaryRow, StoredEvent } from "@fragua/store";
import { runStateToSummary, runSummaryRowToSummary } from "../../src/read-plane/projections.ts";

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
    firstEventTs: 1_000_500,
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

function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "run-1",
    version: 1,
    status: "completed",
    currentNode: null,
    workflowSha: "abc",
    contractVersion: 4,
    routing: {},
    metrics: {
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      loopCounts: {},
      models: {},
      nodeCosts: {},
      activeMs: 0,
    },
    nextSeq: 1,
    lastAppliedSeq: 1,
    priority: 0,
    enqueuedAt: 1_000_000,
    readyAt: 1_000_000,
    nodeStartedAt: null,
    dispatchStartedAt: null,
    updatedAt: 1_001_000,
    title: null,
    baseGitSha: null,
    baseGitRef: null,
    ...overrides,
  } as RunState;
}

function ev(seq: number, ts: number): StoredEvent {
  return { runId: "run-1", seq, ts, type: "run.enqueued", payload: {} } as StoredEvent;
}

describe("runSummaryRowToSummary — timestamps", () => {
  test("projects endedAt from lastEventTs as ISO", () => {
    const summary = runSummaryRowToSummary(baseRow({ lastEventTs: 1_001_000 }));
    expect(summary.endedAt).toBe(new Date(1_001_000).toISOString());
  });

  test("projects enqueuedAt from row.enqueuedAt as ISO", () => {
    const summary = runSummaryRowToSummary(baseRow({ enqueuedAt: 1_000_000 }));
    expect(summary.enqueuedAt).toBe(new Date(1_000_000).toISOString());
  });

  test("omits endedAt when lastEventTs is null", () => {
    const summary = runSummaryRowToSummary(baseRow({ firstEventTs: null, lastEventTs: null }));
    expect(summary.endedAt).toBeUndefined();
  });
});

describe("runStateToSummary — timestamps", () => {
  test("projects endedAt from the last event ts", () => {
    const summary = runStateToSummary(baseState(), [ev(1, 1_000_500), ev(2, 1_001_000)], undefined);
    expect(summary.endedAt).toBe(new Date(1_001_000).toISOString());
  });

  test("projects enqueuedAt from state.enqueuedAt even before first event", () => {
    const summary = runStateToSummary(baseState({ enqueuedAt: 1_000_000 }), [], undefined);
    expect(summary.enqueuedAt).toBe(new Date(1_000_000).toISOString());
    expect(summary.endedAt).toBeUndefined();
  });
});

describe("endedAt is only set for a settled run", () => {
  test("a running run with events has no endedAt", () => {
    const summary = runSummaryRowToSummary(baseRow({ status: "running", lastEventTs: 1_001_000 }));
    expect(summary.endedAt).toBeUndefined();
    expect(summary.enqueuedAt).toBe(new Date(1_000_000).toISOString());
  });

  test("a queued run has no endedAt", () => {
    expect(runSummaryRowToSummary(baseRow({ status: "queued", lastEventTs: 1_001_000 })).endedAt).toBeUndefined();
  });

  test("a paused run has no endedAt — it has not ended", () => {
    expect(runSummaryRowToSummary(baseRow({ status: "paused", lastEventTs: 1_001_000 })).endedAt).toBeUndefined();
  });

  test("every settled status does get an endedAt", () => {
    for (const status of ["completed", "cancelled", "halted", "quarantined"] as const) {
      const summary = runSummaryRowToSummary(baseRow({ status, lastEventTs: 1_001_000 }));
      expect(summary.endedAt).toBe(new Date(1_001_000).toISOString());
    }
  });

  test("runStateToSummary applies the same gate", () => {
    const live = runStateToSummary(baseState({ status: "running" }), [ev(1, 1_001_000)], undefined);
    expect(live.endedAt).toBeUndefined();
    const done = runStateToSummary(baseState({ status: "completed" }), [ev(1, 1_001_000)], undefined);
    expect(done.endedAt).toBe(new Date(1_001_000).toISOString());
  });
});
