import { describe, expect, test } from "bun:test";
import { applyFact, emptyMetrics, type FactEvent, genesisToInitialState, type RunState } from "../src/index.ts";

const BASE = "5".repeat(40);

function checkoutRun(inCheckout = true): RunState {
  return genesisToInitialState(
    "r1",
    {
      workflowSha: "wf",
      projectId: "p",
      projectName: "p",
      routing: {},
      contractVersion: 7,
      ...(inCheckout ? { inCheckout: true as const } : {}),
    },
    1,
  );
}

const fold = (s: RunState, ...facts: FactEvent[]): RunState => facts.reduce((acc, f) => applyFact(acc, f, 2), s);

const started = (baseHeadSha?: string): FactEvent => ({
  type: "fact.run_started",
  payload: {
    workflowSha: "wf",
    contractVersion: 7,
    startNode: "a",
    baseGitSha: BASE,
    ...(baseHeadSha ? { baseHeadSha } : {}),
  },
});
const completed: FactEvent = { type: "fact.run_terminated", payload: { status: "completed", finalNode: "a" } };
const halted: FactEvent = { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } };
const cancelled: FactEvent = { type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 0 } };
const snapshot: FactEvent = {
  type: "fact.snapshot_recorded",
  payload: {
    eventIdx: 3,
    treeSha: "t".repeat(40),
    commitSha: "p".repeat(40),
    parentSnap: BASE,
    headSha: BASE,
    headRef: null,
    diffBaseSha: BASE,
    committed: null,
    uncommitted: { filesChanged: 2, insertions: 3, deletions: 1 },
  },
};

describe("checkout fold", () => {
  test("snapshot_recorded on a completed in-checkout run releases and leaves inboxStatus null", () => {
    const s = fold(checkoutRun(), started(), completed, snapshot);
    expect(s.checkoutReleased).toBe(true);
    expect(s.inboxStatus).toBeNull();
    expect(s.changeStat).toEqual({ committed: null, uncommitted: { filesChanged: 2, insertions: 3, deletions: 1 } });
    expect(s.diffBaseSha).toBe(BASE);
  });

  test("snapshot_recorded on a halted in-checkout run keeps checkoutReleased false", () => {
    const s = fold(checkoutRun(), started(), halted, snapshot);
    expect(s.status).toBe("halted");
    expect(s.checkoutReleased).toBe(false);
    expect(s.inboxStatus).toBeNull();
  });

  test("run_terminated with null baseGitSha auto-releases (never started)", () => {
    expect(fold(checkoutRun(), cancelled).checkoutReleased).toBe(true);
    expect(fold(checkoutRun(), halted).checkoutReleased).toBe(true);
  });

  test("run_terminated after run_started does not release", () => {
    expect(fold(checkoutRun(), started(), cancelled).checkoutReleased).toBe(false);
    expect(fold(checkoutRun(), started(), completed).checkoutReleased).toBe(false);
  });

  test("fact.checkout_released sets checkoutReleased", () => {
    const s = fold(checkoutRun(), started(), halted, { type: "fact.checkout_released", payload: {} });
    expect(s.checkoutReleased).toBe(true);
  });

  test("run_started seeds baseHeadSha", () => {
    const head = "4".repeat(40);
    const s = fold(checkoutRun(), started(head));
    expect(s.baseGitSha).toBe(BASE);
    expect(s.baseHeadSha).toBe(head);
  });

  test("a non-checkout run's fold is unchanged", () => {
    const s = fold(checkoutRun(false), started(), completed, snapshot);
    expect(s.inCheckout).toBe(false);
    expect(s.checkoutReleased).toBe(false);
    expect(s.inboxStatus).toBe("pending");
    expect(fold(checkoutRun(false), cancelled).checkoutReleased).toBe(false);
    expect(emptyMetrics()).toEqual(checkoutRun(false).metrics);
  });
});
