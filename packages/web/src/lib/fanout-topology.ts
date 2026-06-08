// Fan-out topology — parse a workflow's `type: parallel` branch structure ONCE
// for the run-detail surfaces (conversation grouping, cost grouping, graph).
//
// Each `parallel` node's branches are sub-pipelines: a branch ENTRY plus its
// `next:`-closure up to (but excluding) the join. This walks every branch's
// closure and returns the node → parent / node → branch / branch → order maps
// that the views need, plus a node → handler-type map — so a component parses
// the YAML and walks the closures exactly once instead of 2–3× across memos.

import { parseWorkflow } from "@fragua/core";

export interface FanoutTopology {
  /** sub-node id → its `type: parallel` parent (the whole branch closure, not
   * just the entry). */
  parentOf: ReadonlyMap<string, string>;
  /** sub-node id → the branch ENTRY (lens) its `scan → verify → …` sub-pipeline
   * belongs to. */
  branchOf: ReadonlyMap<string, string>;
  /** branch-entry id → its declared index in the parent's `branches:`. */
  orderOf: ReadonlyMap<string, number>;
  /** node id → handler type (`llm` / `tool` / `human` / `parallel` / …). */
  nodeTypes: ReadonlyMap<string, string>;
}

const EMPTY: FanoutTopology = {
  parentOf: new Map(),
  branchOf: new Map(),
  orderOf: new Map(),
  nodeTypes: new Map(),
};

export function fanoutTopology(source: string | undefined): FanoutTopology {
  if (!source) return EMPTY;
  const parentOf = new Map<string, string>();
  const branchOf = new Map<string, string>();
  const orderOf = new Map<string, number>();
  const nodeTypes = new Map<string, string>();
  try {
    const g = parseWorkflow(source);
    for (const [id, node] of Object.entries(g.nodes)) nodeTypes.set(id, node.type);
    // Adjacency index of non-fanout out-edges so each branch-closure BFS is
    // O(closure) instead of O(closure × |edges|).
    const outNonFanout = new Map<string, string[]>();
    for (const e of g.edges) {
      if (e.attrs.fanout === true) continue;
      const arr = outNonFanout.get(e.from);
      if (arr) arr.push(e.to);
      else outNonFanout.set(e.from, [e.to]);
    }
    for (const node of Object.values(g.nodes)) {
      if (node.type !== "parallel" || !Array.isArray(node.attrs.branches)) continue;
      const join = typeof node.attrs.join === "string" ? node.attrs.join : undefined;
      node.attrs.branches.forEach((entry, i) => {
        if (typeof entry !== "string") return;
        orderOf.set(entry, i);
        const queue = [entry];
        const seen = new Set<string>();
        while (queue.length > 0) {
          const x = queue.shift();
          if (x === undefined || x === join || seen.has(x)) continue;
          seen.add(x);
          parentOf.set(x, node.id);
          branchOf.set(x, entry);
          for (const to of outNonFanout.get(x) ?? []) {
            if (to !== join && !seen.has(to)) queue.push(to);
          }
        }
      });
    }
  } catch {
    // Malformed source → empty topology; callers fall back to flat rendering.
    return EMPTY;
  }
  return { parentOf, branchOf, orderOf, nodeTypes };
}
