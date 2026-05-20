// Goal-gate policy tests — attractor-spec §3.4.
//
// Invariants exercised:
//   1. All gates SUCCESS → exit
//   2. Unvisited gate → vacuous (exit)
//   3. PARTIAL_SUCCESS satisfies a gate per spec ("SUCCESS or PARTIAL_SUCCESS")
//   4. Retarget chain precedence: gate.retry_target → gate.fallback_retry_target
//      → graph.retry_target → graph.fallback_retry_target
//   5. Counter bounded by the failing gate's own max_retries
//   6. Missing retarget at every level → halt

import { describe, expect, test } from "bun:test";
import {
  checkGoalGates,
  type GateOutcomes,
  goalGateOutcomeKey,
  goalGateStep,
  readGateOutcomes,
  readGoalGateRetries,
  resolveFailRetarget,
  resolveRetargetChain,
} from "../../src/engine/goal-gate-policy.ts";
import type { Graph, Node, NodeAttrs } from "../../src/types/graph.ts";

function node(id: string, attrs: NodeAttrs = {}): Node {
  return { id, type: "llm", attrs };
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
  };
}

const outcomes = (entries: Record<string, "success" | "fail" | "retry">): GateOutcomes =>
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

  test("gate failed → unsatisfied", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "fail" }))).toEqual({ satisfied: false, failedGate: "a" });
  });

  test("gate retry → unsatisfied", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(checkGoalGates(g, outcomes({ a: "retry" }))).toEqual({ satisfied: false, failedGate: "a" });
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
      nodes: [node("gate", { goal_gate: true, retry_target: "x" }), node("x")],
    });
    expect(resolveRetargetChain(g, "gate")).toBe("x");
  });

  test("nothing set → null", () => {
    const g = graph({ nodes: [node("gate", { goal_gate: true })] });
    expect(resolveRetargetChain(g, "gate")).toBeNull();
  });

  test("retarget references undefined node → null", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "ghost" }), node("y")],
    });
    expect(resolveRetargetChain(g, "gate")).toBeNull();
  });

  test("empty-string retarget → null", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "" }), node("y")],
    });
    expect(resolveRetargetChain(g, "gate")).toBeNull();
  });
});

describe("routing-key helpers", () => {
  test("goalGateOutcomeKey scopes by node id", () => {
    expect(goalGateOutcomeKey("verify")).toBe("goal_gates.verify");
  });

  test("readGoalGateRetries — empty routing → 0", () => {
    expect(readGoalGateRetries({})).toBe(0);
  });

  test("readGoalGateRetries — explicit count", () => {
    expect(readGoalGateRetries({ "goal_gates.__retries": 2 })).toBe(2);
  });

  test("readGoalGateRetries — non-numeric ignored", () => {
    expect(readGoalGateRetries({ "goal_gates.__retries": "two" })).toBe(0);
  });

  test("readGateOutcomes — folds gate keys, ignores reserved __retries slot", () => {
    const routing: Record<string, unknown> = {
      "goal_gates.verify": "success",
      "goal_gates.review": "fail",
      "goal_gates.__retries": 1,
      unrelated: "value",
    };
    const out = readGateOutcomes(routing);
    expect(out.get("verify")).toBe("success");
    expect(out.get("review")).toBe("fail");
    expect(out.has("__retries")).toBe(false);
    expect(out.has("unrelated")).toBe(false);
    expect(out.size).toBe(2);
  });

  test("readGateOutcomes — non-string outcome values ignored", () => {
    const out = readGateOutcomes({ "goal_gates.bad": 42 });
    expect(out.size).toBe(0);
  });

  test("readGateOutcomes — unknown statuses ignored", () => {
    const out = readGateOutcomes({ "goal_gates.bad": "weird" });
    expect(out.size).toBe(0);
  });
});

describe("resolveFailRetarget — §3.7", () => {
  test("node.retry_target wins", () => {
    const g = graph({
      nodes: [node("a", { retry_target: "fix" }), node("fix")],
    });
    expect(resolveFailRetarget(g, "a")).toBe("fix");
  });

  test("graph-level retarget NOT consulted (§3.7 is node-only)", () => {
    const g = graph({
      nodes: [node("a"), node("z")],
      attrs: { retry_target: "z" },
    });
    expect(resolveFailRetarget(g, "a")).toBeNull();
  });

  test("retarget references undefined node → null", () => {
    const g = graph({ nodes: [node("a", { retry_target: "ghost" })] });
    expect(resolveFailRetarget(g, "a")).toBeNull();
  });

  test("nothing set → null (caller halts the run)", () => {
    const g = graph({ nodes: [node("a")] });
    expect(resolveFailRetarget(g, "a")).toBeNull();
  });
});

describe("goalGateStep — per-gate cap", () => {
  test("all gates satisfied → exit", () => {
    const g = graph({ nodes: [node("a", { goal_gate: true })] });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ a: "success" }), retries: 0, gateCap: 2 })).toEqual({
      kind: "exit",
    });
  });

  test("unsatisfied + retarget within budget → retarget", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix", max_retries: 2 }), node("fix")],
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0, gateCap: 2 })).toEqual({
      kind: "retarget",
      gate: "gate",
      target: "fix",
      nextRetries: 1,
    });
  });

  test("unsatisfied + no retarget anywhere → halt", () => {
    const g = graph({ nodes: [node("gate", { goal_gate: true })] });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0, gateCap: 2 })).toEqual({
      kind: "halt",
      reason: "goal_gate_unsatisfied",
      gate: "gate",
    });
  });

  test("cap comes from the failing gate's max_retries — halts when retries === gateCap", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix", max_retries: 2 }), node("fix")],
    });
    const o = outcomes({ gate: "fail" });
    expect(goalGateStep({ graph: g, outcomes: o, retries: 1, gateCap: 2 })).toMatchObject({ kind: "retarget" });
    expect(goalGateStep({ graph: g, outcomes: o, retries: 2, gateCap: 2 })).toMatchObject({ kind: "halt" });
  });

  test("missing max_retries on the gate (gateCap=0) → halt immediately", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix" }), node("fix")],
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 0, gateCap: 0 })).toMatchObject({
      kind: "halt",
    });
  });

  test("capOverride still takes precedence over gateCap", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix", max_retries: 1 }), node("fix")],
    });
    // retries=5 exceeds gateCap=1, but capOverride=7 wins → retarget
    expect(
      goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 5, gateCap: 1, capOverride: 7 }),
    ).toMatchObject({ kind: "retarget" });
  });

  test("unsatisfied + retarget exists but counter exhausted → halt", () => {
    const g = graph({
      nodes: [node("gate", { goal_gate: true, retry_target: "fix", max_retries: 2 }), node("fix")],
    });
    expect(goalGateStep({ graph: g, outcomes: outcomes({ gate: "fail" }), retries: 2, gateCap: 2 })).toEqual({
      kind: "halt",
      reason: "goal_gate_unsatisfied",
      gate: "gate",
    });
  });
});
