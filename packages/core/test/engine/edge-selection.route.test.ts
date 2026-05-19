// Edge selection — Step 0 (route) + Step 1 outcome= attribute matching.
//
// docs/proposals/llm-routing.md Phase 4. Additive only: legacy
// `condition=` edges keep working. Both surfaces are exclusive within
// their step — routing nodes do not fall through to outcome/condition
// edges; outcome-attr edges that don't match the status don't fall
// through to weight/lexical.

import { describe, expect, test } from "bun:test";
import { selectEdge } from "../../src/engine/edge-selection.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";
import type { Outcome } from "../../src/types/outcome.ts";

function makeGraph(nodes: Record<string, Node>, edges: Edge[]): Graph {
  return { id: "G", directed: true, attrs: {}, nodes, edges, subgraphs: [] };
}

function node(id: string, attrs: Partial<Node["attrs"]> = {}): Node {
  return { id, shape: "box", attrs, classes: [] };
}

function edge(from: string, to: string, attrs: Edge["attrs"] = {}): Edge {
  return { from, to, attrs };
}

function outcome(partial: Partial<Outcome> = {}): Outcome {
  return {
    status: "success",
    context_updates: {},
    preferred_label: "",
    suggested_next_ids: [],
    notes: "",
    ...partial,
  };
}

describe("selectEdge — Step 0 route", () => {
  test("route= edge fires for a routing node with matching route", () => {
    const X = node("X", { routes: ["a", "b"] });
    const graph = makeGraph({ X, Y: node("Y"), Z: node("Z") }, [
      edge("X", "Y", { route: "a" }),
      edge("X", "Z", { route: "b" }),
    ]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ route: "a" }), context: {} });
    expect(sel?.edge.to).toBe("Y");
    expect(sel?.rule).toBe("route");
    expect(sel?.matched).toBe("a");
  });

  test("returns undefined when routing node's route has no matching edge", () => {
    // Validator should prevent this at upload; runtime backstop returns
    // undefined so the executor halts with edge_no_match.
    const X = node("X", { routes: ["a", "b"] });
    const graph = makeGraph({ X, Y: node("Y") }, [edge("X", "Y", { route: "a" })]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ route: "b" }), context: {} });
    expect(sel).toBeUndefined();
  });

  test("route case takes precedence when both could conceivably match", () => {
    // Routing node with both route= and outcome=success edges. Step 0
    // is exclusive — outcome edges are never inspected for routing
    // nodes carrying a chosen route.
    const X = node("X", { routes: ["a", "b"] });
    const graph = makeGraph({ X, Y: node("Y"), Z: node("Z") }, [
      edge("X", "Y", { route: "a" }),
      edge("X", "Z", { outcome: "success" }),
    ]);
    const sel = selectEdge({
      graph,
      source: X,
      outcome: outcome({ status: "success", route: "a" }),
      context: {},
    });
    expect(sel?.edge.to).toBe("Y");
    expect(sel?.rule).toBe("route");
  });

  test("routing node without an outcome.route falls through to Step 1", () => {
    // Defensive: a routing-node author misconfigures the handler so
    // the route attr is unset. We don't synthesise a route from the
    // status; Step 0 is gated on `outcome.route` being non-empty.
    const X = node("X", { routes: ["a", "b"] });
    const graph = makeGraph({ X, Y: node("Y") }, [edge("X", "Y", { outcome: "success" })]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "success" }), context: {} });
    expect(sel?.edge.to).toBe("Y");
    expect(sel?.rule).toBe("condition");
  });
});

describe("selectEdge — Step 1 outcome= attribute", () => {
  test("outcome=success edge fires on success for a non-routing node", () => {
    const X = node("X");
    const graph = makeGraph({ X, Y: node("Y"), Z: node("Z") }, [
      edge("X", "Y", { outcome: "success" }),
      edge("X", "Z", { outcome: "fail" }),
    ]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "success" }), context: {} });
    expect(sel?.edge.to).toBe("Y");
    expect(sel?.rule).toBe("condition");
    expect(sel?.matched).toBeUndefined();
  });

  test("outcome=fail edge fires on fail", () => {
    const X = node("X");
    const graph = makeGraph({ X, Y: node("Y"), Z: node("Z") }, [
      edge("X", "Y", { outcome: "success" }),
      edge("X", "Z", { outcome: "fail" }),
    ]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "fail" }), context: {} });
    expect(sel?.edge.to).toBe("Z");
    expect(sel?.rule).toBe("condition");
    expect(sel?.matched).toBeUndefined();
  });

  test("legacy condition='outcome=success' edges still fire", () => {
    // Phase 4 is additive: the condition DSL surface keeps working.
    const X = node("X");
    const graph = makeGraph({ X, Y: node("Y") }, [edge("X", "Y", { condition: "outcome=success" })]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "success" }), context: {} });
    expect(sel?.edge.to).toBe("Y");
    expect(sel?.rule).toBe("condition");
    expect(sel?.matched).toBe("outcome=success");
  });

  test("outcome= and condition= edges coexist and both pool into Step 1", () => {
    // Both surfaces match on outcome=success; they go through the
    // shared weight/lexical tiebreak. The tie resolves lexically by
    // target id when no weight is set; this test pins that both ended
    // up in the conditional pool (i.e. neither was silently skipped).
    const X = node("X");
    const graph = makeGraph({ X, A: node("A"), B: node("B") }, [
      edge("X", "B", { outcome: "success" }),
      edge("X", "A", { condition: "outcome=success" }),
    ]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "success" }), context: {} });
    expect(sel?.rule).toBe("condition");
    // Weight tie: lexical lowest target id wins → "A".
    expect(sel?.edge.to).toBe("A");
  });

  test("outcome= attribute edge that doesn't match is exclusive (no fall-through)", () => {
    // An outcome=success edge on a fail outcome should NOT be picked
    // by Step 4 (weight/lexical fallback). Step 1 filters it out;
    // the unconditional pool excludes outcome-attr edges too.
    const X = node("X");
    const graph = makeGraph({ X, Y: node("Y") }, [edge("X", "Y", { outcome: "success" })]);
    const sel = selectEdge({ graph, source: X, outcome: outcome({ status: "fail" }), context: {} });
    expect(sel).toBeUndefined();
  });
});
