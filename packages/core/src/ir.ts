// Canonical IR (intermediate representation) of a workflow Graph.
//
// (A) of docs/proposals/workflow-ir.md: persist the parsed Graph as JSON so
// the dispatch path deserializes it instead of re-parsing source on every
// load. `loc` (line/col) is validator-only metadata — consumed at upload when
// the freshly-parsed Graph still carries it — and never belongs in the
// executable IR, so the serializer strips it. `workflows.sha` is unchanged
// (still source-hash); making it a hash of this IR is (B), deferred until the
// graph shape is feature-complete.

import type { Graph, Node } from "./types/graph.ts";

/** IR contract version. Bumped when the serialized Graph shape changes; a
 *  converter chain (not built yet — there is no v2) would lift older stored
 *  IR forward on load. Starts at 1. */
export const CURRENT_IR_VERSION = 1;

/** Graph with `loc` removed from every node and edge — the executable
 *  projection. Exported for the round-trip test (parse output carries `loc`;
 *  the persisted/deserialized form does not). */
export function stripLoc(graph: Graph): Graph {
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = omitLoc(node);
  }
  return { ...graph, nodes, edges: graph.edges.map(omitLoc) };
}

function omitLoc<T extends { loc?: unknown }>(o: T): T {
  if (o.loc === undefined) return o;
  const copy = { ...o };
  delete copy.loc;
  return copy;
}

/** Serialize a Graph to the persisted IR JSON (loc stripped). Round-trips
 *  through `deserializeGraph` to a Graph executor-equivalent to the parse
 *  output. */
export function serializeGraph(graph: Graph): string {
  return JSON.stringify(stripLoc(graph));
}

/** Parse persisted IR JSON back to a Graph. Throws on malformed JSON (the
 *  loader maps that to an `unparseable` result, same as a parse failure). */
export function deserializeGraph(ir: string): Graph {
  return JSON.parse(ir) as Graph;
}
