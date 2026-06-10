// Fan-out topology — parse a workflow's `type: parallel` branch structure ONCE
// for the run-detail surfaces (conversation grouping, cost grouping, graph).
//
// Each `parallel` node's branches are sub-pipelines: a branch ENTRY plus its
// `next:`-closure up to (but excluding) the join. This walks every branch's
// closure and returns the node → parent / node → branch / branch → order maps
// that the views need, plus a node → handler-type map — so a component parses
// the YAML and walks the closures exactly once instead of 2–3× across memos.

import { fanoutBranchClosures, parseWorkflow } from "@fragua/core";

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
    for (const node of Object.values(g.nodes)) {
      if (node.type !== "parallel" || !Array.isArray(node.attrs.branches)) continue;
      const join = typeof node.attrs.join === "string" ? node.attrs.join : undefined;
      // The shared closure walk (core engine/fanout.ts) — the same node set
      // the executor budgets over and the validator certifies, so the UI's
      // grouping can't drift from them.
      for (const bc of fanoutBranchClosures(g, { branches: node.attrs.branches, join })) {
        orderOf.set(bc.entry, bc.index);
        for (const x of bc.nodes) {
          parentOf.set(x, node.id);
          branchOf.set(x, bc.entry);
        }
      }
    }
  } catch {
    // Malformed source → empty topology; callers fall back to flat rendering.
    return EMPTY;
  }
  return { parentOf, branchOf, orderOf, nodeTypes };
}
