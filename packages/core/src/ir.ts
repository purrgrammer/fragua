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

/** IR contract version. Bumped when the serialized Graph shape changes.
 * v2 adds the optional `outputs:` block on `llm` and `tool` nodes
 * (structured step outputs, additive). A v1 IR without `outputs` fields
 * is executor-equivalent to a v2 IR with no outputs declared. The v1→v2
 * converter is a no-op structural identity. */
export const CURRENT_IR_VERSION = 2;

/** IR version up-converter chain. Each entry is a function that takes a
 * parsed-but-unvalidated IR JSON value at `fromVersion` and returns the
 * same (or restructured) value at `fromVersion + 1`. The GraphLoader calls
 * `convertIr` to walk the chain before handing the executor a current Graph.
 *
 * The v1→v2 converter is identity (outputs is additive; v1 IRs without the
 * field are already valid v2). The slot is explicit so the loader upgrade
 * path is exercised and future converters follow the pattern. */
export const IR_CONVERTERS: Array<(json: unknown) => unknown> = [
  // v1 → v2: additive outputs field, no structural change needed.
  (json: unknown) => json,
];

/** Walk the converter chain from `fromVersion` to `CURRENT_IR_VERSION`.
 * Returns `{ json, version }` where `version === CURRENT_IR_VERSION`. */
export function convertIr(json: unknown, fromVersion: number): { json: unknown; version: number } {
  let current = json;
  for (let v = fromVersion; v < CURRENT_IR_VERSION; v++) {
    const converter = IR_CONVERTERS[v - 1];
    if (converter === undefined) {
      throw new Error(`no IR converter registered for version ${v} → ${v + 1}`);
    }
    current = converter(current);
  }
  return { json: current, version: CURRENT_IR_VERSION };
}

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
