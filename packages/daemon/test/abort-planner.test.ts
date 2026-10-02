// Unit tests for the pure abort-loop decision (`planAbortLoop`) — the trend
// warning one abort before the ceiling, and the recoverable `abort_loop` pause
// at or past it. The driver owns the counter bump + two-commit sequencing.

import { describe, expect, test } from "bun:test";
import { planAbortLoop } from "../src/abort-planner.ts";

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
