// Property tests for the two-case edge selector (SPEC §3.6). The four laws:
// route case picks the matching route edge; outcome case picks the matching
// outcome edge; an unannotated edge defaults to outcome=success; and there is
// no fall-through — a fail with no fail edge yields no selection (the executor
// then halts at __end__).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../../test/pbt-runs.ts";
import { selectEdge } from "../../src/engine/edge-selection.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";
import type { Outcome } from "../../src/types/outcome.ts";

function graphOf(source: Node, edges: Edge[], extra: string[] = []): Graph {
  const nodes: Record<string, Node> = { [source.id]: source };
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (nodes[id] === undefined) nodes[id] = { id, type: "llm", attrs: {} };
    }
  }
  for (const id of extra) if (nodes[id] === undefined) nodes[id] = { id, type: "llm", attrs: {} };
  return { id: "G", directed: true, attrs: {}, nodes, edges };
}

function outcome(partial: Partial<Outcome> = {}): Outcome {
  return { status: "success", notes: "", ...partial };
}

const routeName = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);

describe("selectEdge — property laws (SPEC §3.6)", () => {
  test("route case: a routing node picks the edge whose route= matches the chosen route", () => {
    fc.assert(
      fc.property(fc.uniqueArray(routeName, { minLength: 1, maxLength: 5 }), fc.nat(), (routes, pickIdx) => {
        const chosen = routes[pickIdx % routes.length]!;
        const source: Node = { id: "A", type: "llm", attrs: { routes } };
        const edges = routes.map((r) => ({ from: "A", to: `t_${r}`, attrs: { route: r } }));
        const sel = selectEdge({ graph: graphOf(source, edges), source, outcome: outcome({ route: chosen }) });
        expect(sel?.rule).toBe("route");
        expect(sel?.matched).toBe(chosen);
        expect(sel?.edge.to).toBe(`t_${chosen}`);
      }),
      { numRuns: pbtRuns(32) },
    );
  });

  test("outcome case: the fail edge is picked iff the outcome status is fail", () => {
    fc.assert(
      fc.property(fc.constantFrom<"success" | "fail">("success", "fail"), (status) => {
        const source: Node = { id: "A", type: "llm", attrs: {} };
        const edges: Edge[] = [
          { from: "A", to: "ok", attrs: { outcome: "success" } },
          { from: "A", to: "recover", attrs: { outcome: "fail" } },
        ];
        const sel = selectEdge({ graph: graphOf(source, edges), source, outcome: outcome({ status }) });
        expect(sel?.rule).toBe("outcome");
        expect(sel?.edge.to).toBe(status === "fail" ? "recover" : "ok");
      }),
      { numRuns: pbtRuns(16) },
    );
  });

  test("default-success: an unannotated edge is selected on success for any target", () => {
    fc.assert(
      fc.property(routeName, (target) => {
        const source: Node = { id: "A", type: "llm", attrs: {} };
        const edges: Edge[] = [{ from: "A", to: target, attrs: {} }];
        const sel = selectEdge({ graph: graphOf(source, edges), source, outcome: outcome({ status: "success" }) });
        expect(sel?.rule).toBe("outcome");
        expect(sel?.edge.to).toBe(target);
      }),
      { numRuns: pbtRuns(32) },
    );
  });

  test("no fall-through: a fail outcome with only success-path edges yields no selection", () => {
    fc.assert(
      fc.property(fc.uniqueArray(routeName, { minLength: 1, maxLength: 4 }), (targets) => {
        const source: Node = { id: "A", type: "llm", attrs: {} };
        // Only success (or unannotated → success) edges — never a fail edge.
        const edges: Edge[] = targets.map((t, i) => ({
          from: "A",
          to: t,
          attrs: i === 0 ? {} : { outcome: "success" as const },
        }));
        const sel = selectEdge({ graph: graphOf(source, edges), source, outcome: outcome({ status: "fail" }) });
        expect(sel).toBeUndefined();
      }),
      { numRuns: pbtRuns(32) },
    );
  });
});
