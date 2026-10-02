// Pure lifecycle-fact planners — the run_paused{operator} / run_started /
// dispatch_started / executor-crash facts the driver used to build inline. No
// store, clock, or randomness: every case is a plain input → plan assertion.

import { describe, expect, test } from "bun:test";
import { planCrashHalt, planDispatchStarted, planOperatorPause, planRunStarted } from "../src/lifecycle-planner.ts";

describe("planOperatorPause", () => {
  test("emits run_paused{reason:operator} at the current node", () => {
    expect(planOperatorPause({ nodeId: "review" }).facts).toEqual([
      { type: "fact.run_paused", payload: { reason: "operator", nodeId: "review" } },
    ]);
  });
});

describe("planRunStarted", () => {
  test("stamps baseGitSha / baseGitRef when present", () => {
    expect(
      planRunStarted({
        workflowSha: "wf1",
        contractVersion: 4,
        startNode: "start",
        baseGitSha: "abc123",
        baseGitRef: "main",
      }).facts,
    ).toEqual([
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf1",
          contractVersion: 4,
          startNode: "start",
          baseGitSha: "abc123",
          baseGitRef: "main",
        },
      },
    ]);
  });

  test("omits baseGitSha / baseGitRef when absent", () => {
    expect(planRunStarted({ workflowSha: "wf1", contractVersion: 4, startNode: "start" }).facts).toEqual([
      { type: "fact.run_started", payload: { workflowSha: "wf1", contractVersion: 4, startNode: "start" } },
    ]);
  });
});

describe("planDispatchStarted", () => {
  test("omits pass at 0 and carries resumeOf", () => {
    expect(planDispatchStarted({ nodeId: "n1", iteration: 2, pass: 0, resumeOf: "fresh" }).facts).toEqual([
      { type: "fact.dispatch_started", payload: { nodeId: "n1", iteration: 2, resumeOf: "fresh" } },
    ]);
  });

  test("stamps pass when > 0", () => {
    expect(planDispatchStarted({ nodeId: "n1", iteration: 0, pass: 3, resumeOf: "paused" }).facts).toEqual([
      { type: "fact.dispatch_started", payload: { nodeId: "n1", iteration: 0, pass: 3, resumeOf: "paused" } },
    ]);
  });
});

describe("planCrashHalt", () => {
  test("emits a handler-agnostic run_terminated{errored} with the driver's detail", () => {
    expect(planCrashHalt({ detail: "executor crashed at n1: boom" }).facts).toEqual([
      {
        type: "fact.run_terminated",
        payload: { status: "errored", reason: "error", detail: "executor crashed at n1: boom" },
      },
    ]);
  });
});
