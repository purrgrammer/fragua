// mkGraph — minimal Graph builder for engine tests.
//
// Engine tests check engine behaviour (edge selection, retry policy,
// validator codes, stylesheet matching, …) and don't need to exercise
// the parser. Building Graph objects directly keeps those tests focused
// on the engine and lets the parser layer be tested independently in
// `packages/core/test/parser/yaml.test.ts`.

import type { Edge, EdgeAttrs, Graph, GraphAttrs, Node, NodeAttrs, NodeShape, Subgraph } from "../../src/types/graph.ts";

const SHAPE: Record<string, NodeShape> = {
  start: "Mdiamond",
  exit: "Msquare",
  llm: "box",
  human: "hexagon",
  tool: "parallelogram",
};

export type NodeKind = keyof typeof SHAPE;
export type NodeSpec = NodeKind | { type: NodeKind; attrs?: NodeAttrs; classes?: string[] };
export type EdgeSpec =
  | [string, string]
  | [string, string, EdgeAttrs]
  | { from: string; to: string; attrs?: EdgeAttrs };

/** Build a Graph from a terse object spec.
 *
 *   mkGraph({
 *     nodes: { s: "start", work: "llm", done: "exit" },
 *     edges: [["s", "work"], ["work", "done"]],
 *   });
 *
 * Nodes default to no attrs; pass `{ type, attrs: {...} }` for attribute
 * coverage. Edges accept a 2-tuple, a 3-tuple with attrs, or an explicit
 * `{from, to, attrs}` object — pick whichever reads cleanest at the
 * call-site. */
export function mkGraph(opts: {
  id?: string;
  attrs?: GraphAttrs;
  nodes: Record<string, NodeSpec>;
  edges?: EdgeSpec[];
  subgraphs?: Subgraph[];
}): Graph {
  const nodes: Record<string, Node> = {};
  for (const [id, spec] of Object.entries(opts.nodes)) {
    const type = typeof spec === "string" ? spec : spec.type;
    const attrs: NodeAttrs = { ...(typeof spec === "string" ? {} : spec.attrs ?? {}) };
    const shape = SHAPE[type];
    if (!shape) throw new Error(`mkGraph: unknown node type "${type}" for "${id}"`);
    attrs.shape = shape;
    const declaredClasses = typeof spec !== "string" && Array.isArray(spec.classes) ? spec.classes : [];
    const attrClasses =
      typeof attrs.class === "string" && attrs.class.length > 0
        ? attrs.class.split(/[,\s]+/).filter(Boolean)
        : [];
    const classes = [...new Set([...declaredClasses, ...attrClasses])];
    nodes[id] = { id, shape, attrs, classes };
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
    subgraphs: opts.subgraphs ?? [],
  };
}
