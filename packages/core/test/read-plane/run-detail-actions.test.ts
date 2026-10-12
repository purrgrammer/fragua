import { describe, expect, test } from "bun:test";
import type { IEventReader, RunState, StoredEvent } from "@fragua/store";
import { makeReadPlane } from "../../src/read-plane/plane.ts";
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
    baseHeadSha: null,
    inCheckout: false,
    checkoutPath: null,
    checkoutReleased: false,
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

describe("checkout fields on the read plane", () => {
  test("runDetail and controlState carry inCheckout, checkoutPath and checkoutReleased", () => {
    const state = baseState({ status: "halted", inCheckout: true, checkoutPath: "/co", checkoutReleased: false });
    const detail = runStateToDetail(state, [ev(1, 1_000_500)], undefined, undefined);
    expect(detail.inCheckout).toBe(true);
    expect(detail.checkoutPath).toBe("/co");
    expect(detail.checkoutReleased).toBe(false);
    const plain = runStateToDetail(baseState(), [ev(1, 1_000_500)], undefined, undefined);
    expect(plain.inCheckout).toBeUndefined();

    const rp = makeReadPlane({ store: { getState: () => state } as unknown as IEventReader });
    expect(rp.controlState("run-1")).toMatchObject({ inCheckout: true, checkoutPath: "/co", checkoutReleased: false });
  });

  test("checkoutHeld returns the holder", () => {
    const seen: string[] = [];
    const rp = makeReadPlane({
      store: {
        getCheckoutHolder: (key: string) => {
          seen.push(key);
          return key === "/co" ? { runId: "r1", status: "running" } : null;
        },
      } as unknown as IEventReader,
    });
    expect(rp.checkoutHeld("/co")).toEqual({ runId: "r1", status: "running" });
    expect(rp.checkoutHeld("/free")).toBeNull();
    expect(seen).toEqual(["/co", "/free"]);
  });
});
