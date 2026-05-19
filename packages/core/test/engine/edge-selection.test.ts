import { describe, expect, test } from "bun:test";
import { outgoingEdges, selectEdge } from "../../src/engine/edge-selection.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";
import type { Outcome } from "../../src/types/outcome.ts";

function g(nodes: string[], edges: Edge[]): Graph {
  const n: Record<string, Node> = {};
  for (const id of nodes) n[id] = { id, shape: "box", attrs: {}, classes: [] };
  return { id: "G", directed: true, attrs: {}, nodes: n, edges, subgraphs: [] };
}

function edge(from: string, to: string, attrs: Edge["attrs"] = {}): Edge {
  return { from, to, attrs };
}

function outcome(partial: Partial<Outcome> = {}): Outcome {
  return { status: "success", notes: "", ...partial };
}

const nodeA: Node = { id: "A", shape: "box", attrs: {}, classes: [] };

describe("outgoingEdges", () => {
  test("returns only edges from the given source", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B"), edge("A", "C"), edge("B", "C")]);
    const out = outgoingEdges(graph, "A");
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.from === "A")).toBe(true);
  });

  test("returns empty array when no outgoing edges", () => {
    const graph = g(["A", "B"], [edge("B", "A")]);
    expect(outgoingEdges(graph, "A")).toHaveLength(0);
  });
});

// ─── Boundary ───────────────────────────────────────────────────────────────

describe("selectEdge — boundary", () => {
  test("source with no outgoing edges returns undefined", () => {
    const graph = g(["A"], []);
    expect(selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} })).toBeUndefined();
  });

  test("non-routing source with no outgoing edges returns undefined", () => {
    const routingNode: Node = { id: "A", shape: "box", attrs: { routes: ["x", "y"] }, classes: [] };
    const graph = g(["A"], []);
    expect(selectEdge({ graph, source: routingNode, outcome: outcome({ route: "x" }), context: {} })).toBeUndefined();
  });
});

// ─── Outcome case (non-routing source) ──────────────────────────────────────

describe("selectEdge — outcome case (non-routing source)", () => {
  test("unannotated edge defaults to outcome=success and fires on success", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "success" }), context: {} });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("outcome");
  });

  test("outcome=fail edge fires on fail outcome", () => {
    const graph = g(["A", "B", "C"], [edge("A", "B", { outcome: "fail" }), edge("A", "C", { outcome: "success" })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "fail" }), context: {} });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("outcome");
  });

  test("fail with no matching fail-edge returns undefined (executor halts)", () => {
    // An unannotated edge defaults to outcome=success, so a fail outcome
    // must NOT silently match it.
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "fail" }), context: {} });
    expect(res).toBeUndefined();
  });

  test("explicit outcome=success edge fires on success", () => {
    const graph = g(["A", "B"], [edge("A", "B", { outcome: "success" })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "success" }), context: {} });
    expect(res?.edge.to).toBe("B");
    expect(res?.rule).toBe("outcome");
  });

  test("outcome=fail does not match a success outcome", () => {
    const graph = g(["A", "B"], [edge("A", "B", { outcome: "fail" })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "success" }), context: {} });
    expect(res).toBeUndefined();
  });

  test("retry status matches outcome=fail edge only when annotated fail", () => {
    // outcome=fail does not fire for status=retry
    const graph = g(["A", "B"], [edge("A", "B", { outcome: "fail" })]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome({ status: "retry" }), context: {} });
    expect(res).toBeUndefined();
  });

  test("matched field is absent for outcome-case selections", () => {
    const graph = g(["A", "B"], [edge("A", "B")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.matched).toBeUndefined();
  });

  test("first matching edge wins (graph source order)", () => {
    // Both edges match outcome=success (one explicit, one implicit).
    const graph = g(["A", "X", "Y"], [edge("A", "X", { outcome: "success" }), edge("A", "Y")]);
    const res = selectEdge({ graph, source: nodeA, outcome: outcome(), context: {} });
    expect(res?.edge.to).toBe("X");
  });
});

// ─── Route case (routing source) ────────────────────────────────────────────

describe("selectEdge — route case (routing source)", () => {
  const routingNode: Node = { id: "A", shape: "box", attrs: { routes: ["small", "feature", "blocked"] }, classes: [] };

  test("route matches edge keyed by route=", () => {
    const graph = g(
      ["A", "X", "Y", "Z"],
      [edge("A", "X", { route: "small" }), edge("A", "Y", { route: "feature" }), edge("A", "Z", { route: "blocked" })],
    );
    const res = selectEdge({ graph, source: routingNode, outcome: outcome({ route: "feature" }), context: {} });
    expect(res?.edge.to).toBe("Y");
    expect(res?.rule).toBe("route");
    expect(res?.matched).toBe("feature");
  });

  test("route with no matching edge returns undefined", () => {
    const graph = g(["A", "X"], [edge("A", "X", { route: "small" })]);
    const res = selectEdge({ graph, source: routingNode, outcome: outcome({ route: "missing" }), context: {} });
    expect(res).toBeUndefined();
  });

  test("routing source with no route in outcome returns undefined", () => {
    const graph = g(["A", "X"], [edge("A", "X", { route: "small" })]);
    const res = selectEdge({ graph, source: routingNode, outcome: outcome(), context: {} });
    expect(res).toBeUndefined();
  });

  test("routing source with empty route string returns undefined", () => {
    const graph = g(["A", "X"], [edge("A", "X", { route: "small" })]);
    const res = selectEdge({ graph, source: routingNode, outcome: outcome({ route: "" }), context: {} });
    expect(res).toBeUndefined();
  });

  test("matched carries the chosen route name", () => {
    const graph = g(["A", "X"], [edge("A", "X", { route: "blocked" })]);
    const res = selectEdge({ graph, source: routingNode, outcome: outcome({ route: "blocked" }), context: {} });
    expect(res?.matched).toBe("blocked");
    expect(res?.rule).toBe("route");
  });

  test("outcome= attributes on edges of a routing node are ignored (route= takes over)", () => {
    // A routing node with an outcome=success edge should NOT match
    // the outcome-case path — it can only match via route=.
    const graph = g(["A", "X"], [edge("A", "X", { outcome: "success" })]);
    const res = selectEdge({ graph, source: routingNode, outcome: outcome({ route: "small" }), context: {} });
    expect(res).toBeUndefined();
  });
});
