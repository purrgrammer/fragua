// Budget policy — unit tests for the pure read-and-enforce module.
// See docs/ARCHITECTURE.md §13.1 (budget) for context.

import { describe, expect, test } from "bun:test";
import { BUDGET_WARN_RATIO, evaluateBudget } from "../../src/engine/budget-policy.ts";
import type { GraphAttrs, NodeAttrs } from "../../src/types/graph.ts";

const NO_TAGS: ReadonlySet<string> = new Set();

function input(over: Partial<Parameters<typeof evaluateBudget>[0]>): Parameters<typeof evaluateBudget>[0] {
  return {
    graphAttrs: {} as GraphAttrs,
    completedNodeId: "n",
    cumulativeCostUsd: 0,
    cumulativeTokens: 0,
    nodeCumulativeCostUsd: 0,
    nodeCumulativeTokens: 0,
    alreadyWarned: NO_TAGS,
    ...over,
  };
}

describe("evaluateBudget", () => {
  test("no ceilings configured → empty decision", () => {
    const d = evaluateBudget(input({ cumulativeCostUsd: 999, cumulativeTokens: 999_999 }));
    expect(d).toEqual({ events: [], shouldHalt: false, newlyWarned: [] });
  });

  test("under warn threshold → no events", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0 } as GraphAttrs,
        cumulativeCostUsd: 0.5,
      }),
    );
    expect(d.events).toHaveLength(0);
    expect(d.shouldHalt).toBe(false);
  });

  test("first warn fires once and surfaces newlyWarned tag", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0 } as GraphAttrs,
        cumulativeCostUsd: BUDGET_WARN_RATIO * 1.0 + 0.01, // just over threshold
      }),
    );
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("budget.warn");
    expect(d.shouldHalt).toBe(false);
    expect(d.newlyWarned).toEqual(["run:cost"]);
  });

  test("repeat warn (tag already in alreadyWarned) does not re-emit", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0 } as GraphAttrs,
        cumulativeCostUsd: 0.85,
        alreadyWarned: new Set(["run:cost"]),
      }),
    );
    expect(d.events).toHaveLength(0);
    expect(d.newlyWarned).toEqual([]);
  });

  test("ceiling crossed with default policy → stop event + halt", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0 } as GraphAttrs,
        cumulativeCostUsd: 1.5,
      }),
    );
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("budget.stop");
    expect(d.shouldHalt).toBe(true);
    expect(d.haltReason).toMatch(/run cost budget exhausted/);
  });

  test("ceiling crossed with policy='warn' → stop event but no halt", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0, budget_policy: "warn" } as GraphAttrs,
        cumulativeCostUsd: 1.5,
      }),
    );
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("budget.stop");
    expect(d.shouldHalt).toBe(false);
  });

  test("per-node cost ceiling — under warn → silent", () => {
    const d = evaluateBudget(
      input({
        completedNodeAttrs: { max_cost_usd: 1.0 } as NodeAttrs,
        nodeCumulativeCostUsd: 0.4,
      }),
    );
    expect(d.events).toHaveLength(0);
  });

  test("per-node cost breach → stop with caller_node_id", () => {
    const d = evaluateBudget(
      input({
        completedNodeId: "expensive-node",
        completedNodeAttrs: { max_cost_usd: 0.5 } as NodeAttrs,
        nodeCumulativeCostUsd: 0.6,
      }),
    );
    expect(d.events).toHaveLength(1);
    expect(d.events[0]?.type).toBe("budget.stop");
    expect((d.events[0]?.payload as { scope: string }).scope).toBe("node");
    expect((d.events[0]?.payload as { caller_node_id: string }).caller_node_id).toBe("expensive-node");
    expect(d.shouldHalt).toBe(true);
  });

  test("per-node tokens breach", () => {
    const d = evaluateBudget(
      input({
        completedNodeAttrs: { max_tokens: 1000 } as NodeAttrs,
        nodeCumulativeTokens: 1500,
      }),
    );
    expect(d.events).toHaveLength(1);
    expect((d.events[0]?.payload as { scope: string; metric: string }).metric).toBe("tokens");
    expect(d.shouldHalt).toBe(true);
  });

  test("run-level cost breach takes precedence over node-level token breach", () => {
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0 } as GraphAttrs,
        completedNodeAttrs: { max_tokens: 100 } as NodeAttrs,
        cumulativeCostUsd: 1.5,
        nodeCumulativeTokens: 5000,
      }),
    );
    // Only one stop event, and it must be the run-level cost one.
    const stops = d.events.filter((e) => e.type === "budget.stop");
    expect(stops).toHaveLength(1);
    expect((stops[0]?.payload as { scope: string; metric: string }).scope).toBe("run");
    expect((stops[0]?.payload as { scope: string; metric: string }).metric).toBe("cost");
  });

  test("run.cost before run.tokens before node.cost before node.tokens", () => {
    // All four would breach individually — only the highest-priority one
    // appears as the stop event.
    const d = evaluateBudget(
      input({
        graphAttrs: { budget_usd: 1.0, budget_tokens: 100 } as GraphAttrs,
        completedNodeAttrs: { max_cost_usd: 0.1, max_tokens: 10 } as NodeAttrs,
        cumulativeCostUsd: 99,
        cumulativeTokens: 9999,
        nodeCumulativeCostUsd: 50,
        nodeCumulativeTokens: 900,
      }),
    );
    const stops = d.events.filter((e) => e.type === "budget.stop");
    expect(stops).toHaveLength(1);
    expect((stops[0]?.payload as { scope: string; metric: string }).scope).toBe("run");
    expect((stops[0]?.payload as { scope: string; metric: string }).metric).toBe("cost");
  });

  test("warn payload includes ratio; stop payload omits ratio", () => {
    const warn = evaluateBudget(input({ graphAttrs: { budget_usd: 1.0 } as GraphAttrs, cumulativeCostUsd: 0.85 }))
      .events[0]!;
    expect(typeof (warn.payload as { ratio?: number }).ratio).toBe("number");

    const stop = evaluateBudget(input({ graphAttrs: { budget_usd: 1.0 } as GraphAttrs, cumulativeCostUsd: 1.2 }))
      .events[0]!;
    expect((stop.payload as { ratio?: number }).ratio).toBeUndefined();
  });
});
