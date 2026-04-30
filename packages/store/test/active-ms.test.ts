// Reducer tests for `metrics.activeMs` and `dispatchStartedAt` —
// the bookkeeping that lets analytics distinguish active dispatch
// time from time spent paused / dead-daemon.

import { describe, expect, test } from "bun:test";
import { applyFact, emptyMetrics, type FactEvent, foldFacts, type RunState } from "../src/index.ts";

function blankState(): RunState {
  return {
    runId: "r",
    version: 0,
    status: "queued",
    currentNode: null,
    workflowSha: "wf",
    schemaVersion: 1,
    routing: {},
    metrics: emptyMetrics(),
    nextSeq: 1,
    lastAppliedSeq: 0,
    priority: 0,
    enqueuedAt: 0,
    readyAt: 0,
    nodeStartedAt: null,
    dispatchStartedAt: null,
    updatedAt: 0,
    title: null,
  };
}

const RUN_STARTED: FactEvent = {
  type: "fact.run_started",
  payload: { workflowSha: "wf", schemaVersion: 1, startNode: "a" },
};

function dispatchStarted(now: number, resumeOf: "fresh" | "crash" | "paused_hitl" | "paused_provider_error"): FactEvent {
  // `now` is a label only — the reducer reads its own `now` arg. Kept
  // here so call sites read like the timeline.
  void now;
  return {
    type: "fact.dispatch_started",
    payload: { nodeId: "a", iteration: 0, resumeOf },
  };
}

const NODE_COMPLETED: FactEvent = {
  type: "fact.node_completed",
  payload: { nodeId: "a", iteration: 0, tokens: 0, costUsd: 0, nextNode: "b" },
};

const RUN_PAUSED_HITL: FactEvent = {
  type: "fact.run_paused_hitl",
  payload: { nodeId: "a", label: "pick", options: [] },
};

const RUN_RESUMED: FactEvent = {
  type: "fact.run_resumed",
  payload: { fromStatus: "paused_hitl" },
};

const RUN_COMPLETED: FactEvent = {
  type: "fact.run_completed",
  payload: { finalNode: "b" },
};

const RUN_REQUEUED: FactEvent = {
  type: "fact.run_requeued_after_crash",
  payload: { prevNode: "a" },
};

describe("dispatch interval bookkeeping", () => {
  test("fact.run_started sets dispatchStartedAt to `now`", () => {
    const s = applyFact(blankState(), RUN_STARTED, 100);
    expect(s.dispatchStartedAt).toBe(100);
    expect(s.metrics.activeMs).toBe(0);
  });

  test("fact.dispatch_started sets dispatchStartedAt to `now`", () => {
    const s0 = applyFact(blankState(), RUN_STARTED, 100);
    const s1 = applyFact({ ...s0, dispatchStartedAt: null }, dispatchStarted(500, "crash"), 500);
    expect(s1.dispatchStartedAt).toBe(500);
  });

  test("run_started @ t=100 → node_completed @ t=500: activeMs == 400, dispatchStartedAt == null", () => {
    const s0 = applyFact(blankState(), RUN_STARTED, 100);
    const s1 = applyFact(s0, NODE_COMPLETED, 500);
    expect(s1.metrics.activeMs).toBe(400);
    expect(s1.dispatchStartedAt).toBeNull();
  });

  test("HITL pause-resume cycle: activeMs sums only the active spans", () => {
    let s = applyFact(blankState(), RUN_STARTED, 100);
    s = applyFact(s, RUN_PAUSED_HITL, 200);
    expect(s.metrics.activeMs).toBe(100);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, RUN_RESUMED, 1000);
    expect(s.metrics.activeMs).toBe(100);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(1100, "paused_hitl"), 1100);
    expect(s.dispatchStartedAt).toBe(1100);

    s = applyFact(s, RUN_COMPLETED, 1500);
    expect(s.metrics.activeMs).toBe(100 + 400);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("crash recovery: dead-daemon window dropped, post-resume span counted", () => {
    // Sweep emits run_requeued_after_crash with `now=sweep_time`, which
    // is much later than the actual crash. The reducer can't tell
    // pre-crash active time from dead-daemon time, so it drops the
    // whole pre-crash span. activeMs only accumulates the post-resume
    // dispatch interval.
    let s = applyFact(blankState(), RUN_STARTED, 100);
    s = applyFact(s, RUN_REQUEUED, 900);
    expect(s.metrics.activeMs).toBe(0);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(950, "crash"), 950);
    expect(s.dispatchStartedAt).toBe(950);

    s = applyFact(s, NODE_COMPLETED, 1200);
    expect(s.metrics.activeMs).toBe(250);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("multiple pause + crash cycles still produce accurate durations", () => {
    // Timeline with two pause cycles and two crash cycles. Only the
    // active dispatch spans count toward activeMs:
    //   t=100   run_started               (active span 1 begins)
    //   t=300   paused_hitl               (+200 → activeMs=200)
    //   t=900   resumed
    //   t=1000  dispatch_started          (active span 2 begins)
    //   t=1500  requeued_after_crash      (dropped: dead-daemon time)
    //   t=2000  dispatch_started          (active span 3 begins)
    //   t=2200  paused_provider_error     (+200 → activeMs=400)
    //   t=2900  resumed
    //   t=3000  dispatch_started          (active span 4 begins)
    //   t=3500  requeued_after_crash      (dropped)
    //   t=4000  dispatch_started          (active span 5 begins)
    //   t=4300  run_completed             (+300 → activeMs=700)
    let s = applyFact(blankState(), RUN_STARTED, 100);
    s = applyFact(s, RUN_PAUSED_HITL, 300);
    expect(s.metrics.activeMs).toBe(200);

    s = applyFact(s, RUN_RESUMED, 900);
    s = applyFact(s, dispatchStarted(1000, "paused_hitl"), 1000);
    s = applyFact(s, RUN_REQUEUED, 1500);
    expect(s.metrics.activeMs).toBe(200);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(2000, "crash"), 2000);
    s = applyFact(
      s,
      { type: "fact.run_paused_provider_error", payload: { nodeId: "a", httpStatus: 500, provider: "p", errorMessage: "" } },
      2200,
    );
    expect(s.metrics.activeMs).toBe(400);

    s = applyFact(
      s,
      { type: "fact.run_resumed", payload: { fromStatus: "paused_provider_error" } },
      2900,
    );
    s = applyFact(s, dispatchStarted(3000, "paused_provider_error"), 3000);
    s = applyFact(s, RUN_REQUEUED, 3500);
    expect(s.metrics.activeMs).toBe(400);

    s = applyFact(s, dispatchStarted(4000, "crash"), 4000);
    s = applyFact(s, RUN_COMPLETED, 4300);
    expect(s.metrics.activeMs).toBe(700);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("foldFacts is idempotent: same event list folded twice yields identical state", () => {
    const facts: FactEvent[] = [RUN_STARTED, RUN_PAUSED_HITL, RUN_RESUMED, dispatchStarted(0, "paused_hitl"), RUN_COMPLETED];
    // The reducer reads `now` per-call, so to make folding deterministic
    // we synthesise a single `now` for the whole fold; that's what the
    // store does at write time too (one ts per appendFact call). Each
    // event then collapses to a zero-duration interval, so activeMs ends
    // at 0 — but the projection (status, dispatchStartedAt, currentNode)
    // must be identical across both folds.
    const a = foldFacts(blankState(), facts, 1234);
    const b = foldFacts(blankState(), facts, 1234);
    expect(a).toEqual(b);
  });
});
