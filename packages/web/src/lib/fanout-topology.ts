// Fan-out topology — record → Map adapter over `RunDetail.fanout`.
//
// The topology is SERVED by the read-plane (derived there via the shared
// core closure walk over each `type: parallel` node's branches), so the
// UI's grouping can't drift from what the executor budgets over and the
// validator certifies. No client-side YAML parse, no silent catch — this
// module only lifts the four wire records into the four Maps the
// run-detail surfaces (conversation grouping, cost grouping) consume.

import type { RunDetail } from "./api.ts";

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

export function fanoutTopology(records: RunDetail["fanout"] | undefined): FanoutTopology {
  if (!records) return EMPTY;
  return {
    parentOf: new Map(Object.entries(records.parentOf)),
    branchOf: new Map(Object.entries(records.branchOf)),
    orderOf: new Map(Object.entries(records.orderOf)),
    nodeTypes: new Map(Object.entries(records.nodeTypes)),
  };
}
