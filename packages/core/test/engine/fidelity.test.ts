import { describe, expect, test } from "bun:test";
import { degradeOnResume, resolveFidelity, resolveThreadId } from "../../src/engine/fidelity.ts";
import type { Edge, Graph, Node } from "../../src/types/graph.ts";

function makeGraph(partial: Partial<Graph> = {}): Graph {
  return {
    id: "g",
    directed: true,
    attrs: {},
    nodes: {},
    edges: [],
    subgraphs: [],
    ...partial,
  };
}

function makeNode(partial: Partial<Node> = {}): Node {
  return {
    id: partial.id ?? "n",
    shape: partial.shape ?? "box",
    attrs: partial.attrs ?? {},
    classes: partial.classes ?? [],
  };
}

function makeEdge(partial: Partial<Edge> = {}): Edge {
  return {
    from: partial.from ?? "a",
    to: partial.to ?? "b",
    attrs: partial.attrs ?? {},
  };
}

describe("resolveFidelity", () => {
  test("edge attr wins over node attr", () => {
    const graph = makeGraph({ attrs: { default_fidelity: "truncate" } });
    const target = makeNode({ attrs: { fidelity: "full" } });
    const edge = makeEdge({ attrs: { fidelity: "summary:low" } });
    expect(resolveFidelity({ graph, edge, targetNode: target })).toBe("summary:low");
  });

  test("target node attr wins over graph default", () => {
    const graph = makeGraph({ attrs: { default_fidelity: "truncate" } });
    const target = makeNode({ attrs: { fidelity: "full" } });
    expect(resolveFidelity({ graph, edge: undefined, targetNode: target })).toBe("full");
  });

  test("graph default wins over hard default", () => {
    const graph = makeGraph({ attrs: { default_fidelity: "truncate" } });
    const target = makeNode();
    expect(resolveFidelity({ graph, edge: undefined, targetNode: target })).toBe("truncate");
  });

  test("hard default is compact", () => {
    const graph = makeGraph();
    const target = makeNode();
    expect(resolveFidelity({ graph, edge: undefined, targetNode: target })).toBe("compact");
  });
});

describe("resolveThreadId", () => {
  test("target node thread_id wins", () => {
    const graph = makeGraph({ attrs: { thread_id: "graph-t" } });
    const target = makeNode({ attrs: { thread_id: "node-t" }, classes: ["class-c"] });
    const edge = makeEdge({ attrs: { thread_id: "edge-t" } });
    expect(resolveThreadId({ graph, edge, targetNode: target, sourceNode: makeNode({ id: "prev" }) })).toBe("node-t");
  });

  test("edge thread_id used when node has none", () => {
    const graph = makeGraph({ attrs: { thread_id: "graph-t" } });
    const target = makeNode({ classes: ["class-c"] });
    const edge = makeEdge({ attrs: { thread_id: "edge-t" } });
    expect(resolveThreadId({ graph, edge, targetNode: target, sourceNode: makeNode({ id: "prev" }) })).toBe("edge-t");
  });

  test("graph thread_id used when node+edge have none", () => {
    const graph = makeGraph({ attrs: { thread_id: "graph-t" } });
    const target = makeNode({ classes: ["class-c"] });
    expect(resolveThreadId({ graph, edge: undefined, targetNode: target, sourceNode: makeNode({ id: "prev" }) })).toBe(
      "graph-t",
    );
  });

  test("subgraph-derived class used when no explicit thread_id", () => {
    const graph = makeGraph();
    const target = makeNode({ classes: ["loop-a"] });
    expect(resolveThreadId({ graph, edge: undefined, targetNode: target, sourceNode: makeNode({ id: "prev" }) })).toBe(
      "loop-a",
    );
  });

  test("previous node id is fallback", () => {
    const graph = makeGraph();
    const target = makeNode();
    expect(resolveThreadId({ graph, edge: undefined, targetNode: target, sourceNode: makeNode({ id: "prev" }) })).toBe(
      "prev",
    );
  });

  test("undefined when no source and no other hints", () => {
    const graph = makeGraph();
    const target = makeNode();
    expect(resolveThreadId({ graph, edge: undefined, targetNode: target })).toBeUndefined();
  });
});

describe("degradeOnResume", () => {
  test("full degrades to summary:high", () => {
    expect(degradeOnResume("full")).toBe("summary:high");
  });

  test("other modes unchanged", () => {
    expect(degradeOnResume("compact")).toBe("compact");
    expect(degradeOnResume("truncate")).toBe("truncate");
    expect(degradeOnResume("summary:low")).toBe("summary:low");
  });
});
