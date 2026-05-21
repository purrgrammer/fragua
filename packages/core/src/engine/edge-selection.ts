// Edge selection: two cases.
// See docs/SPEC.md §3.6.
//
//   Route case  — source node declares `routes=`: pick the edge whose
//                 `attrs.route` equals `outcome.route`.
//   Outcome case — all other nodes: pick the edge whose `attrs.outcome`
//                  equals the outcome status. Unannotated edges default
//                  to `outcome=success`.
//
// If no edge matches, returns undefined. The executor halts the run
// (edge_no_match for routing nodes; aborted_exit / terminal for
// outcome nodes that have no fail-edge declared).

import type { Edge, Graph, Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";

export type EdgeSelectionRule = "route" | "outcome";

export interface EdgeSelection {
  edge: Edge;
  rule: EdgeSelectionRule;
  /** Route name when rule is "route". Absent for outcome-case. */
  matched?: string;
}

export interface EdgeSelectionInput {
  graph: Graph;
  source: Node;
  outcome: Outcome;
}

/** Outgoing edges of `source` in the order they appear in graph.edges. */
export function outgoingEdges(graph: Graph, sourceId: string): Edge[] {
  return graph.edges.filter((e) => e.from === sourceId);
}

export function selectEdge(input: EdgeSelectionInput): EdgeSelection | undefined {
  const edges = outgoingEdges(input.graph, input.source.id);
  if (edges.length === 0) return undefined;

  const sourceRoutes = input.source.attrs.routes;
  if (Array.isArray(sourceRoutes) && sourceRoutes.length > 0) {
    const chosen = input.outcome.route;
    if (typeof chosen !== "string" || chosen.length === 0) return undefined;
    const match = edges.find((e) => e.attrs.route === chosen);
    return match !== undefined ? { edge: match, rule: "route", matched: chosen } : undefined;
  }

  const status = input.outcome.status;
  const match = edges.find((e) => (e.attrs.outcome ?? "success") === status);
  return match !== undefined ? { edge: match, rule: "outcome" } : undefined;
}
