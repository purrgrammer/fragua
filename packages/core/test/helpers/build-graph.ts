// mkGraph — minimal Graph builder for engine tests.
//
// Engine tests check engine behaviour (edge selection, retry policy,
// validator codes, etc.) and don't need to exercise the parser. Building
// Graph objects directly keeps those tests focused on the engine and
// lets the parser layer be tested independently in
// `packages/core/test/parser/yaml.test.ts`.

import type { Edge, EdgeAttrs, Graph, GraphAttrs, Node, NodeAttrs, NodeType } from "../../src/types/graph.ts";

export type NodeSpec = NodeType | { type: NodeType; attrs?: NodeAttrs };
export type EdgeSpec = [string, string] | [string, string, EdgeAttrs] | { from: string; to: string; attrs?: EdgeAttrs };

/** Build a Graph from a terse object spec.
 *
 *   mkGraph({
 *     nodes: { s: "start", work: "llm", done: "exit" },
 *     edges: [["s", "work"], ["work", "done"]],
 *   });
 *
 * Nodes default to no attrs; pass `{ type, attrs: {...} }` for attribute
 * coverage. Edges accept a 2-tuple, a 3-tuple with attrs, or an explicit
 * `{from, to, attrs}` object. */
export function mkGraph(opts: {
  id?: string;
  attrs?: GraphAttrs;
  nodes: Record<string, NodeSpec>;
  edges?: EdgeSpec[];
}): Graph {
  const nodes: Record<string, Node> = {};
  for (const [id, spec] of Object.entries(opts.nodes)) {
    const type = typeof spec === "string" ? spec : spec.type;
    const attrs: NodeAttrs = typeof spec === "string" ? {} : { ...(spec.attrs ?? {}) };
    nodes[id] = { id, type, attrs };
  }
  const edges: Edge[] = (opts.edges ?? []).map((e) => {
    if (Array.isArray(e)) {
      return { from: e[0], to: e[1], attrs: (e[2] ?? {}) as EdgeAttrs };
    }
    return { from: e.from, to: e.to, attrs: e.attrs ?? {} };
  });
  return {
    id: opts.id ?? "test",
    directed: true,
    attrs: opts.attrs ?? {},
    nodes,
    edges,
  };
}
