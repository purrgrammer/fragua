// Unit tests for the pure exit-planner helpers: the abort-loop decision
// (`planAbortLoop` / `planAbortLoops`) — the trend warning one abort before the
// ceiling, and the recoverable `abort_loop` pause at or past it — the exit
// classifier, the budget-breach producer, and the leak arm of `planExit`. The
// driver owns the counter bump + two-commit sequencing.

import { describe, expect, test } from "bun:test";
import {
  classifyExit,
  type ExitClassifyInput,
  planAbortLoop,
  planAbortLoops,
  planBudgetBreach,
  planExit,
} from "../src/abort-planner.ts";

describe("planAbortLoop", () => {
  test("warns once at ceiling-1 without a pause", () => {
    const plan = planAbortLoop({ consecutiveAborts: 4, ceiling: 5, nodeId: "impl" });
    expect(plan.warn).toEqual({
      type: "abort_loop_warning",
      payload: { nodeId: "impl", consecutiveAborts: 4, ceiling: 5 },
    });
    expect(plan.pause).toBeUndefined();
  });

  test("pauses with abort_loop at the ceiling, no warn", () => {
    const plan = planAbortLoop({ consecutiveAborts: 5, ceiling: 5, nodeId: "impl" });
    expect(plan.pause).toEqual({
      type: "fact.run_paused",
      payload: { reason: "abort_loop", nodeId: "impl", consecutiveAborts: 5 },
    });
    expect(plan.warn).toBeUndefined();
  });

  test("below the warn boundary plans nothing", () => {
    const plan = planAbortLoop({ consecutiveAborts: 2, ceiling: 5, nodeId: "impl" });
    expect(plan.warn).toBeUndefined();
    expect(plan.pause).toBeUndefined();
  });

  test("past the ceiling still pauses (never both warn and pause)", () => {
    const plan = planAbortLoop({ consecutiveAborts: 9, ceiling: 5, nodeId: "impl" });
    expect(plan.pause).toBeDefined();
    expect(plan.warn).toBeUndefined();
  });
});

describe("planAbortLoops", () => {
  test("planAbortLoops pauses the first branch at the ceiling and warns one before", () => {
    const plan = planAbortLoops(
      new Map([
        ["a", 4],
        ["b", 5],
        ["c", 7],
      ]),
      5,
    );
    expect(plan.pause).toEqual({
      type: "fact.run_paused",
      payload: { reason: "abort_loop", nodeId: "b", consecutiveAborts: 5 },
    });
    expect(plan.warns).toEqual([
      { type: "abort_loop_warning", payload: { nodeId: "a", consecutiveAborts: 4, ceiling: 5 } },
    ]);
  });

  test("no branch at or near the ceiling → no pause, no warns", () => {
    expect(planAbortLoops(new Map([["a", 1]]), 5)).toEqual({ warns: [] });
  });
});

describe("classifyExit", () => {
  const base: ExitClassifyInput = {
    invocation: "thrown",
    abortByName: false,
    signalAborted: false,
    shutdownAborted: false,
    abortCause: "aborted",
    budgetTripped: false,
  };

  test("a leak is a leak whatever else tripped", () => {
    expect(classifyExit({ ...base, invocation: "leak", abortByName: true, shutdownAborted: true })).toBe("leak");
  });

  test("a plain throw on a live signal is a throw", () => {
    expect(classifyExit(base)).toBe("throw");
  });

  test("a throw while the signal had tripped is an abort even when not named AbortError", () => {
    expect(classifyExit({ ...base, signalAborted: true })).toBe("abort");
  });

  test("a timeout cause wins over shutdown", () => {
    expect(classifyExit({ ...base, abortByName: true, abortCause: "timeout", shutdownAborted: true })).toBe("timeout");
  });

  test("a shutdown-tripped abort is a shutdown", () => {
    expect(classifyExit({ ...base, abortByName: true, signalAborted: true, shutdownAborted: true })).toBe("shutdown");
  });

  test("a budget trip is an abort", () => {
    expect(classifyExit({ ...base, budgetTripped: true })).toBe("abort");
  });
});

describe("planBudgetBreach", () => {
  test("halt detail → fact.run_terminated{budget} carrying it", () => {
    expect(planBudgetBreach({ haltDetail: "run cost 1.50 > 1.00" }, "p")).toEqual({
      type: "fact.run_terminated",
      payload: { status: "errored", reason: "budget", detail: "run cost 1.50 > 1.00" },
    });
  });

  test("empty halt detail → no detail field", () => {
    expect(planBudgetBreach({ haltDetail: "" }, "p")).toEqual({
      type: "fact.run_terminated",
      payload: { status: "errored", reason: "budget" },
    });
  });

  test("pause breach → fact.run_paused{budget} with scope/metric/limit/actual and nodeId", () => {
    expect(planBudgetBreach({ pauseBreach: { scope: "node", metric: "cost", limit: 1, actual: 2 } }, "p")).toEqual({
      type: "fact.run_paused",
      payload: { reason: "budget", nodeId: "p", scope: "node", metric: "cost", limit: 1, actual: 2 },
    });
  });

  test("no breach → undefined", () => {
    expect(planBudgetBreach({}, "p")).toBeUndefined();
  });
});

describe("planExit — leak arm", () => {
  test("leads with the spend, then handler_timeout_leaked and the handler_leaked halt at the injected leakedAt", () => {
    const usage = {
      turnBilled: 10,
      totalCostUsd: 0.2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
    };
    const plan = planExit({
      exit: "leak",
      currentNode: "slow",
      iteration: 0,
      leakedAt: 12345,
      reactiveBudgetHaltDetail: undefined,
      reactiveBudgetPauseBreach: undefined,
      usage,
      routingDelta: {},
      appliedSeqs: [],
      effectiveRouting: {},
      now: 99,
      attemptedMs: 0,
    });
    expect(plan.outcome).toBe("halt");
    expect(plan.facts).toEqual([
      {
        type: "fact.node_aborted",
        payload: { nodeId: "slow", iteration: 0, cause: "leak", partialTokens: 10, partialCostUsd: 0.2 },
      },
      { type: "fact.handler_timeout_leaked", payload: { nodeId: "slow", leakedAt: 12345 } },
      { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
    ]);
  });
});
