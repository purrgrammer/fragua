// Unit tests for the PURE pre-dispatch planner (`planPreDispatch` /
// `planLeakHalt`). No store, clock, or randomness — every case is the
// plain-data decision the executor's driver reads, then applies.

import { describe, expect, test } from "bun:test";
import type { FactEvent, RunState } from "@fragua/store";
import { planLeakHalt, planPreDispatch, workflowParseFailedDetail } from "../src/predispatch-planner.ts";

const WINDOW = { min: 1, max: 6 };

function mkState(over: Partial<RunState> = {}): RunState {
  return {
    runId: "r",
    version: 1,
    status: "running",
    currentNode: "n",
    workflowSha: "g",
    contractVersion: 3,
    routing: {},
    metrics: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, nodeCosts: {} },
    ...over,
  } as unknown as RunState;
}

/** A run-parking fact — the "terminal" fact the property bounds to at most one. */
function isParkingFact(f: FactEvent): boolean {
  return f.type === "fact.run_paused" || f.type === "fact.run_terminated";
}

const clear = { dispatches: 0, effectiveMaxLoops: Number.POSITIVE_INFINITY };

describe("planPreDispatch", () => {
  test("engine-incompatible pin pauses with the contract window", () => {
    const plan = planPreDispatch({ state: mkState({ contractVersion: 9 }), contractWindow: WINDOW, ...clear });
    expect(plan.terminal).toBe(true);
    expect(plan.facts).toEqual([
      {
        type: "fact.run_paused",
        payload: { reason: "engine_incompatible", pinnedVersion: 9, supportedMin: 1, supportedMax: 6 },
      },
    ]);
  });

  test("unparseable workflow halts with a bounded parse detail", () => {
    const long = "x".repeat(500);
    const plan = planPreDispatch({ state: mkState(), contractWindow: WINDOW, graphParseError: long, ...clear });
    expect(plan.terminal).toBe(true);
    expect(plan.facts).toHaveLength(1);
    const f = plan.facts[0]!;
    expect(f.type).toBe("fact.run_terminated");
    const payload = f.payload as { status: string; reason: string; detail: string };
    expect(payload).toMatchObject({ status: "errored", reason: "error" });
    expect(payload.detail.startsWith("workflow_parse_failed: ")).toBe(true);
    expect(payload.detail.length).toBeLessThan(long.length);
    expect(payload.detail.endsWith("…")).toBe(true);
  });

  test("worktree provision failure halts with worktree_error carrying the detail", () => {
    const plan = planPreDispatch({
      state: mkState(),
      contractWindow: WINDOW,
      worktreeError: "git worktree add failed",
      ...clear,
    });
    expect(plan.terminal).toBe(true);
    expect(plan.facts).toEqual([
      {
        type: "fact.run_terminated",
        payload: {
          status: "errored",
          reason: "worktree_error",
          detail: "worktree_provision_failed: git worktree add failed",
        },
      },
    ]);
  });

  test("dispatch ceiling reached pauses with max_loops", () => {
    const plan = planPreDispatch({
      state: mkState(),
      contractWindow: WINDOW,
      dispatches: 1000,
      effectiveMaxLoops: 1000,
    });
    expect(plan.terminal).toBe(true);
    expect(plan.facts).toEqual([
      { type: "fact.run_paused", payload: { reason: "max_loops", currentLimit: 1000, dispatches: 1000 } },
    ]);
  });

  test("a healthy pre-dispatch input plans no facts", () => {
    const plan = planPreDispatch({ state: mkState(), contractWindow: WINDOW, dispatches: 5, effectiveMaxLoops: 1000 });
    expect(plan.terminal).toBe(false);
    expect(plan.facts).toEqual([]);
  });

  test("contract gate wins over an unparseable workflow (runtime precedence)", () => {
    const plan = planPreDispatch({
      state: mkState({ contractVersion: 99 }),
      contractWindow: WINDOW,
      graphParseError: "boom",
      ...clear,
    });
    expect(plan.facts).toHaveLength(1);
    expect((plan.facts[0]!.payload as { reason: string }).reason).toBe("engine_incompatible");
  });

  test("pure: identical input ⇒ identical plan, no arm ever emits >1 parking fact", () => {
    const input = { state: mkState({ contractVersion: 42 }), contractWindow: WINDOW, ...clear };
    expect(planPreDispatch(input)).toEqual(planPreDispatch(input));
    expect(planPreDispatch(input).facts.filter(isParkingFact)).toHaveLength(1);
  });
});

describe("planLeakHalt", () => {
  test("emits handler_timeout_leaked then a run_terminated, with the injected leakedAt", () => {
    const plan = planLeakHalt({ nodeId: "slow", leakedAt: 12345 });
    expect(plan.terminal).toBe(true);
    expect(plan.facts).toEqual([
      { type: "fact.handler_timeout_leaked", payload: { nodeId: "slow", leakedAt: 12345 } },
      { type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "handler_leaked" } },
    ]);
    expect(plan.facts.filter(isParkingFact)).toHaveLength(1);
  });
});

describe("workflowParseFailedDetail", () => {
  test("undefined / empty → the bare marker", () => {
    expect(workflowParseFailedDetail(undefined)).toBe("workflow_parse_failed");
    expect(workflowParseFailedDetail("")).toBe("workflow_parse_failed");
  });
});
