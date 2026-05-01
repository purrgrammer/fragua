// Goal-gate policy tests — attractor-spec §3.4.
//
// Invariants exercised:
//   1. All gates SUCCESS → exit
//   2. Unvisited gate → vacuous (exit)
//   3. PARTIAL_SUCCESS satisfies a gate per spec ("SUCCESS or PARTIAL_SUCCESS")
//   4. Retarget chain precedence: gate.retry_target → gate.fallback_retry_target
//      → graph.retry_target → graph.fallback_retry_target
//   5. Counter bounded by max_goal_gate_retries (default 3)
//   6. Missing retarget at every level → halt

import { describe, expect, test } from "bun:test";
import {
  checkGoalGates,
  DEFAULT_MAX_GOAL_GATE_RETRIES,
  type GateOutcomes,
  goalGateStep,
  maxGoalGateRetries,
  resolveRetargetChain,
} from "../../src/engine/goal-gate-policy.ts";
import type { Graph, Node, NodeAttrs } from "../../src/types/graph.ts";

function node(id: string, attrs: NodeAttrs = {}): Node {
  return { id, shape: "box", attrs, classes: [] };
}

function graph(parts: { nodes: Node[]; attrs?: Graph["attrs"] }): Graph {
  const nodes: Record<string, Node> = {};
  for (const n of parts.nodes) nodes[n.id] = n;
  return {
    id: "g",
    directed: true,
    attrs: parts.attrs ?? {},
    nodes,
    edges: [],
    subgraphs: [],
  };
}

const outcomes = (entries: Record<string, "success" | "partial_success" | "fail" | "retry" | "skipped">): GateOutcomes =>
  new Map(Object.entries(entries));

describe("checkGoalGates", () => {
  test("no gates → satisfied", () => {
    const g = graph({ nodes: [node("a")] });
    expect(checkGoalGates(g, outcomes({ a: "success" }))).toEqual({ satisfied: true });
  });

  test("gate succeeded → satisfied", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "success" }))).toEqual({ satisfied: true });
  });

  test("gate partial_success → satisfied (attractor §3.4)", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "partial_success" }))).toEqual({ satisfied: true });
  });

  test("gate failed → unsatisfied", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "fail" }))).toEqual({ satisfied: false, failedGate: "a" });
  });

  test("gate retry → unsatisfied", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "retry" }))).toEqual({ satisfied: false, failedGate: "a" });
  });

  test("gate skipped → unsatisfied (skipped is not success-like for gates)", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "skipped" }))).toEqual({ satisfied: false, failedGate: "a" });
  });

  test("unvisited gate → vacuously satisfied (run never reached it)", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true }), node("b")] });
    expect(checkGoalGates(g, outcomes({ b: "success" }))).toEqual({ satisfied: true });
  });

  test("two gates, one fails → first failed (visit order) reported", () => {
    const g = graph({
      nodes: [node("a", { goal_gate: true }), node("b", { goal_gate: true })],
    });
    expect(checkGoalGates(g, outcomes({ a: "success", b: "fail" }))).toEqual({
      satisfied: false,
      failedGate: "b",
    });
    expect(checkGoalGates(g, outcomes({ a: "fail", b: "success" }))).toEqual({
      satisfied: false,
      failedGate: "a",
    });
  });
});

describe("resolveRetargetChain", () => {
  test("gate.retry_target wins when set", () => {
    const g = graph({
      nodes: [
        node("gate", { goal_gate: true, retry_target: "x", fallback_retry_target: "y" }),
        node("x"),
        node("y"),
        node("z"),
      ],
      attrs: { retry_target: "z" },
    });
    expect(resolveRetargetChain(g, "gate")).toBe("x");
  });

  test("gate.fallback_retry_target when retry_target missing", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, fallback_retry_target: "y" }), node("y")],
    });
    expect(resolveRetargetChain(g, "gate")).toBe("y");
  });

  test("graph.retry_target when gate has none", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true }), node("z")],
      attrs: { retry_target: "z" },
    });
    expect(resolveRetargetChain(g, "gate")).toBe("z");
  });

  test("graph.fallback_retry_target when graph.retry_target missing", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true }), node("w")],
      attrs: { fallback_retry_target: "w" },
    });
    expect(resolveRetargetChain(g, "gate")).toBe("w");
  });

  test("nothing set → null", () => {
    const g = graph({ nodes: [node("gate", { goal_gate: true })] });
    expect(resolveRetargetChain(g, "gate")).toBeNull();
  });

  test("retarget references undefined node → fall through", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "ghost" }), node("y")],
      attrs: { fallback_retry_target: "y" },
    });
    expect(resolveRetargetChain(g, "gate")).toBe("y");
  });

  test("empty-string retarget → fall through", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "" }), node("y")],
      attrs: { retry_target: "y" },
    });
    expect(resolveRetargetChain(g, "gate")).toBe("y");
  });
});

describe("maxGoalGateRetries", () => {
  test("default when unset", () => {
    expect(maxGoalGateRetries({})).toBe(DEFAULT_MAX_GOAL_GATE_RETRIES);
  });

  test("explicit value", () => {
    expect(maxGoalGateRetries({ max_goal_gate_retries: 7 })).toBe(7);
  });

  test("0 means no retries", () => {
    expect(maxGoalGateRetries({ max_goal_gate_retries: 0 })).toBe(0);
  });

  test("negative clamps to 0", () => {
    expect(maxGoalGateRetries({ max_goal_gate_retries: -2 })).toBe(0);
  });

  test("non-finite falls back to default", () => {
    expect(maxGoalGateRetries({ max_goal_gate_retries: Number.NaN })).toBe(DEFAULT_MAX_GOAL_GATE_RETRIES);
  });
});

describe("goalGateStep", () => {
  test("all gates satisfied → exit", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ a: "success" }), retries: 0 })).toEqual({
      kind: "exit",
    });
  });

  test("unsatisfied + retarget within budget → retarget", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix" }), node("fix")],
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0 })).toEqual({
      kind: "retarget",
      gate: "gate",
      target: "fix",
      nextRetries: 1,
    });
  });

  test("unsatisfied + no retarget anywhere → halt", () => {
    const g = graph({ nodes: [node("gate", { goal_gate: true })] });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0 })).toEqual({
      kind: "halt",
      reason: "goal_gate_unsatisfied",
      gate: "gate",
    });
  });

  test("unsatisfied + retarget exists but counter exhausted → halt", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix" }), node("fix")],
      attrs: { max_goal_gate_retries: 2 },
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 2 })).toEqual({
      kind: "halt",
      reason: "goal_gate_unsatisfied",
      gate: "gate",
    });
  });

  test("default cap of 3 — third retry still allowed, fourth halts", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix" }), node("fix")],
    });
    const o = outcomes({ gate: "fail" });
    expect(goalGateStep({ graph: g, outcomes: o, retries: 2 })).toMatchObject({ kind: "retarget" });
    expect(goalGateStep({ graph: g, outcomes: o, retries: 3 })).toMatchObject({ kind: "halt" });
  });

  test("retry_target=0 (max_goal_gate_retries) and a failed gate → halt immediately", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix" }), node("fix")],
      attrs: { max_goal_gate_retries: 0 },
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0 })).toMatchObject({
      kind: "halt",
    });
  });
});
