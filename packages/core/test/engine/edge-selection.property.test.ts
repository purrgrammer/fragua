// Property tests for selectEdge — the 5-rule priority from attractor §3.3 /
// docs/SPEC.md §3.8. The fixed-example suite in edge-selection.test.ts
// anchors specific spec clauses; this file exercises the referential-
// transparency / determinism envelope across random graphs + outcomes.
//
// Invariants exercised:
//   1. Referential transparency — same (graph, source, outcome, context) →
//      same EdgeSelection, every call, every process.
//   2. Closure — the returned edge is always one of source's outgoing edges.
//   3. Condition-matched outcomes pick a condition-rule edge — when at
//      least one edge's condition evaluates true, the selected rule is
//      "condition" and the chosen edge's condition matched.
//   4. Lexical fallback ties → smallest target id wins among tied
//      unconditional edges.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { outgoingEdges, selectEdge } from "../../src/engine/edge-selection.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";
import type { Outcome, OutcomeStatus } from "../../src/types/outcome.ts";

const STATUSES: OutcomeStatus[] = ["success", "partial_success", "retry", "skipped", "fail"];

function outcomeArb(): fc.Arbitrary<Outcome> {
  return fc.record({
    status: fc.constantFrom(...STATUSES),
    context_updates: fc.constant({}),
    preferred_label: fc.oneof(fc.constant(""), fc.string({ minLength: 1, maxLength: 10 })),
    suggested_next_ids: fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 3 }),
    notes: fc.constant(""),
  });
}

/** Generate a small graph: 1 source node "A" + 2–5 target nodes with names
 * drawn from a fixed alphabet so tiebreaks are exercised. Edges are random
 * subsets with assorted condition / label / weight attributes. */
function graphArb(): fc.Arbitrary<{ graph: Graph; source: Node }> {
  const targetIds = fc.subarray(["B", "C", "D", "E", "F"], { minLength: 1, maxLength: 5 });
  return targetIds.chain((targets) => {
    const edgesArb = fc.array(
      fc.record({
        to: fc.constantFrom(...targets),
        condition: fc.oneof(
          fc.constant<string | undefined>(undefined),
          fc.constantFrom<string>("outcome=success", "outcome=fail", "outcome=retry", "outcome=partial_success"),
        ),
        label: fc.oneof(fc.constant<string | undefined>(undefined), fc.constantFrom("yes", "no", "retry-me")),
        weight: fc.oneof(fc.constant<number | undefined>(undefined), fc.integer({ min: 0, max: 5 })),
      }),
      { minLength: 1, maxLength: 8 },
    );
    return edgesArb.map((raw) => {
      const edges: Edge[] = raw.map((r) => {
        const attrs: Edge["attrs"] = {};
        if (r.condition !== undefined) attrs.condition = r.condition;
        if (r.label !== undefined) attrs.label = r.label;
        if (r.weight !== undefined) attrs.weight = r.weight;
        return { from: "A", to: r.to, attrs };
      });
      const nodes: Record<string, Node> = {
        A: { id: "A", shape: "box", attrs: {}, classes: [] },
      };
      for (const t of targets) nodes[t] = { id: t, shape: "box", attrs: {}, classes: [] };
      const graph: Graph = { id: "G", directed: true, attrs: {}, nodes, edges, subgraphs: [] };
      return { graph, source: nodes["A"]! };
    });
  });
}

describe("selectEdge — determinism + closure properties", () => {
  test("referential transparency: same input → same output across repeated calls", () => {
    fc.assert(
      fc.property(graphArb(), outcomeArb(), ({ graph, source }, outcome) => {
        const a = selectEdge({ graph, source, outcome, context: {} });
        const b = selectEdge({ graph, source, outcome, context: {} });
        const c = selectEdge({ graph, source, outcome, context: {} });
        // Compare via JSON — EdgeSelection is JSON-safe and this sidesteps
        // bun:test's toEqual signature rejecting `T | undefined`.
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        expect(JSON.stringify(c)).toBe(JSON.stringify(a));
      }),
    );
  });

  test("closure: selected edge (when defined) is among source's outgoing edges", () => {
    fc.assert(
      fc.property(graphArb(), outcomeArb(), ({ graph, source }, outcome) => {
        const sel = selectEdge({ graph, source, outcome, context: {} });
        if (sel == null) return;
        const outgoing = outgoingEdges(graph, source.id);
        expect(outgoing).toContainEqual(sel.edge);
      }),
    );
  });

  test("when at least one conditional edge matches the outcome, rule='condition'", () => {
    fc.assert(
      fc.property(graphArb(), outcomeArb(), ({ graph, source }, outcome) => {
        const outgoing = outgoingEdges(graph, source.id);
        const anyMatch = outgoing.some((e) => e.attrs.condition && e.attrs.condition === `outcome=${outcome.status}`);
        if (!anyMatch) return;
        const sel = selectEdge({ graph, source, outcome, context: {} });
        expect(sel).not.toBeUndefined();
        expect(sel!.rule).toBe("condition");
      }),
    );
  });

  test("no outgoing edges → undefined", () => {
    const nodes: Record<string, Node> = { A: { id: "A", shape: "box", attrs: {}, classes: [] } };
    const graph: Graph = { id: "G", directed: true, attrs: {}, nodes, edges: [], subgraphs: [] };
    fc.assert(
      fc.property(outcomeArb(), (outcome) => {
        expect(selectEdge({ graph, source: nodes["A"]!, outcome, context: {} })).toBeUndefined();
      }),
    );
  });

  test("unconditional-only + no preferred_label/suggested: tied-weight → lexical winner is smallest target id", () => {
    // Construct a deterministic scenario to exercise the lexical tiebreak.
    const nodes: Record<string, Node> = {
      A: { id: "A", shape: "box", attrs: {}, classes: [] },
      B: { id: "B", shape: "box", attrs: {}, classes: [] },
      C: { id: "C", shape: "box", attrs: {}, classes: [] },
      D: { id: "D", shape: "box", attrs: {}, classes: [] },
    };
    const graph: Graph = {
      id: "G",
      directed: true,
      attrs: {},
      nodes,
      edges: [
        { from: "A", to: "D", attrs: { weight: 1 } },
        { from: "A", to: "B", attrs: { weight: 1 } },
        { from: "A", to: "C", attrs: { weight: 1 } },
      ],
      subgraphs: [],
    };
    const outcome: Outcome = {
      status: "success",
      context_updates: {},
      preferred_label: "",
      suggested_next_ids: [],
      notes: "",
    };
    const sel = selectEdge({ graph, source: nodes["A"]!, outcome, context: {} });
    expect(sel?.edge.to).toBe("B");
    expect(sel?.rule).toBe("lexical");
  });
});
