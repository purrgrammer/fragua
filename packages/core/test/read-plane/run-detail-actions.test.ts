import { describe, expect, test } from "bun:test";
import type { RunState, StoredEvent } from "@fragua/store";
import { runStateToDetail } from "../../src/read-plane/projections.ts";

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
    inboxStatus: null,
    changeStat: null,
    acceptedSha: null,
    ...overrides,
  } as RunState;
}

function ev(seq: number, ts: number): StoredEvent {
  return { runId: "run-1", seq, ts, type: "run.enqueued", payload: {} } as StoredEvent;
}

describe("runStateToDetail — inbox + priority projection", () => {
  test("folds inbox_status onto RunDetail for a pending terminal worktree run", () => {
    const detail = runStateToDetail(baseState({ inboxStatus: "pending" }), [ev(1, 1_000_500)], undefined, undefined);
    expect(detail.inboxStatus).toBe("pending");
  });

  test("folds run_state.priority onto RunDetail", () => {
    const detail = runStateToDetail(baseState({ priority: 7 }), [ev(1, 1_000_500)], undefined, undefined);
    expect(detail.priority).toBe(7);
  });

  test("omits inboxStatus when the run is not in the inbox", () => {
    const detail = runStateToDetail(baseState({ inboxStatus: null }), [ev(1, 1_000_500)], undefined, undefined);
    expect(detail.inboxStatus).toBeUndefined();
  });
});
