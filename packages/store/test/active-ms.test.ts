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
    baseGitSha: null,
    branch: null,
    cwd: null,
    workflowName: null,
    workflowScope: null,
    workflowPath: null,
    scheduleId: null,
  };
}

const RUN_STARTED: FactEvent = {
  type: "fact.run_started",
  payload: { workflowSha: "wf", schemaVersion: 1, startNode: "a" },
};

function dispatchStarted(now: number, resumeOf: "fresh" | "crash" | "paused_hitl" | "paused"): FactEvent {
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

function runRequeued(lastAliveAt?: number): FactEvent {
  const payload: { prevNode: string; lastAliveAt?: number } = { prevNode: "a" };
  if (lastAliveAt != null) payload.lastAliveAt = lastAliveAt;
  return { type: "fact.run_requeued_after_crash", payload };
}

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

  test("crash recovery (no lastAliveAt): pre-crash span dropped, post-resume span counted", () => {
    // Clean-acquire path: prior daemon released its lock cleanly but
    // left a 'running' run behind, so sweep has no priorHeartbeatAt
    // to thread. The reducer can't tell pre-crash active time from
    // idle time, so it drops the pre-crash span entirely. activeMs
    // only accumulates the post-resume dispatch interval.
    let s = applyFact(blankState(), RUN_STARTED, 100);
    s = applyFact(s, runRequeued(), 900);
    expect(s.metrics.activeMs).toBe(0);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(950, "crash"), 950);
    expect(s.dispatchStartedAt).toBe(950);

    s = applyFact(s, NODE_COMPLETED, 1200);
    expect(s.metrics.activeMs).toBe(250);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("crash recovery (with lastAliveAt): pre-crash span credited up to last heartbeat", () => {
    // Reaper path: sweep captured the dying daemon's last heartbeat
    // and threaded it into the payload as `lastAliveAt`. The reducer
    // uses `lastAliveAt - dispatchStartedAt` so the pre-crash active
    // span is credited within ~5s of the real crash time.
    let s = applyFact(blankState(), RUN_STARTED, 100);
    // dispatchStartedAt=100, lastAliveAt=750 → +650 to activeMs
    s = applyFact(s, runRequeued(750), 900);
    expect(s.metrics.activeMs).toBe(650);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(950, "crash"), 950);
    s = applyFact(s, NODE_COMPLETED, 1200);
    expect(s.metrics.activeMs).toBe(650 + 250);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("crash recovery (lastAliveAt earlier than dispatchStartedAt): clamp to zero", () => {
    // Defensive: a clock skew or stale heartbeat that predates the
    // current dispatch must not produce negative activeMs.
    let s = applyFact(blankState(), RUN_STARTED, 1000);
    s = applyFact(s, runRequeued(500), 2000);
    expect(s.metrics.activeMs).toBe(0);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("multiple pause + crash cycles produce accurate durations with lastAliveAt", () => {
    // Timeline with two pause cycles and two crash cycles. Pre-crash
    // active spans are credited via `lastAliveAt` (heartbeat captured
    // ~10ms before sweep time):
    //   t=100   run_started                       (span 1 begins)
    //   t=300   paused_hitl                       (+200 → activeMs=200)
    //   t=900   resumed
    //   t=1000  dispatch_started                  (span 2 begins)
    //   t=1500  requeued_after_crash @1490        (+490 → activeMs=690)
    //   t=2000  dispatch_started                  (span 3 begins)
    //   t=2200  paused (provider_error)           (+200 → activeMs=890)
    //   t=2900  resumed
    //   t=3000  dispatch_started                  (span 4 begins)
    //   t=3500  requeued_after_crash @3490        (+490 → activeMs=1380)
    //   t=4000  dispatch_started                  (span 5 begins)
    //   t=4300  run_completed                     (+300 → activeMs=1680)
    let s = applyFact(blankState(), RUN_STARTED, 100);
    s = applyFact(s, RUN_PAUSED_HITL, 300);
    expect(s.metrics.activeMs).toBe(200);

    s = applyFact(s, RUN_RESUMED, 900);
    s = applyFact(s, dispatchStarted(1000, "paused_hitl"), 1000);
    s = applyFact(s, runRequeued(1490), 1500);
    expect(s.metrics.activeMs).toBe(690);
    expect(s.dispatchStartedAt).toBeNull();

    s = applyFact(s, dispatchStarted(2000, "crash"), 2000);
    s = applyFact(
      s,
      {
        type: "fact.run_paused",
        payload: { reason: "provider_error", nodeId: "a", httpStatus: 500, provider: "p", errorMessage: "" },
      },
      2200,
    );
    expect(s.metrics.activeMs).toBe(890);

    s = applyFact(s, { type: "fact.run_resumed", payload: { fromStatus: "paused" } }, 2900);
    s = applyFact(s, dispatchStarted(3000, "paused"), 3000);
    s = applyFact(s, runRequeued(3490), 3500);
    expect(s.metrics.activeMs).toBe(1380);

    s = applyFact(s, dispatchStarted(4000, "crash"), 4000);
    s = applyFact(s, RUN_COMPLETED, 4300);
    expect(s.metrics.activeMs).toBe(1680);
    expect(s.dispatchStartedAt).toBeNull();
  });

  test("foldFacts is idempotent: same event list folded twice yields identical state", () => {
    const facts: FactEvent[] = [
      RUN_STARTED,
      RUN_PAUSED_HITL,
      RUN_RESUMED,
      dispatchStarted(0, "paused_hitl"),
      RUN_COMPLETED,
    ];
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
