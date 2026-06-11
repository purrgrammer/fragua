// Branch-closure walk for `type: parallel` fan-out nodes — THE shared
// definition of "which nodes belong to a branch". Four surfaces reason over
// this set (the executor's per-node budget scope, the validator's
// E039/E044/W015 oracles, the web UI's branch grouping, CLI explain), and
// hand-rolled copies had already drifted on guards (missing-node checks,
// adjacency indexing). One walk keeps them in lockstep: a closure is the
// branch ENTRY plus everything reachable from it over non-fanout edges,
// stopping at (and excluding) the join; ids that aren't defined nodes are
// skipped (dangling targets are E004's problem, not the closure's).

import type { Graph } from "../types/graph.ts";

export interface BranchClosure {
  /** The branch ENTRY node (listed in the parallel node's `branches:`). */
  entry: string;
  /** Declared index in `branches:`. */
  index: number;
  /** Entry + non-fanout descendants up to (excluding) the join, in BFS visit
   * order. Only defined nodes appear. */
  nodes: string[];
  /** True when some closure node has a non-fanout edge into the join. */
  reachesJoin: boolean;
}

/** Walk every branch closure of one parallel node. Pure; O(V + E) per call
 * (one adjacency index over the graph's non-fanout edges). */
export function fanoutBranchClosures(
  graph: Graph,
  parallel: { branches: readonly unknown[]; join: string | undefined },
): BranchClosure[] {
  // A parallel node without a join is malformed (E038; the executor halts it
  // as fanout_malformed) — without this guard the BFS termination check never
  // fires and the walk tags everything downstream as branch members.
  if (parallel.join === undefined) return [];
  const outNonFanout = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.attrs.fanout === true) continue;
    const arr = outNonFanout.get(e.from);
    if (arr) arr.push(e.to);
    else outNonFanout.set(e.from, [e.to]);
  }
  const closures: BranchClosure[] = [];
  parallel.branches.forEach((rawEntry, index) => {
    if (typeof rawEntry !== "string") return;
    const entry = rawEntry;
    const nodes: string[] = [];
    const seen = new Set<string>();
    const queue = [entry];
    let reachesJoin = false;
    while (queue.length > 0) {
      const x = queue.shift()!;
      if (x === parallel.join || seen.has(x) || graph.nodes[x] === undefined) continue;
      seen.add(x);
      nodes.push(x);
      for (const to of outNonFanout.get(x) ?? []) {
        if (to === parallel.join) reachesJoin = true;
        else if (!seen.has(to)) queue.push(to);
      }
    }
    closures.push({ entry, index, nodes, reachesJoin });
  });
  return closures;
}

/** The union of every branch closure — the sub-node set a parallel node's
 * per-node budget cap sums over (branch completions commit under SUB-NODE
 * ids, never the parallel node, so the parent's own cost bucket is always 0). */
export function fanoutClosureUnion(
  graph: Graph,
  parallel: { branches: readonly unknown[]; join: string | undefined },
): Set<string> {
  const union = new Set<string>();
  for (const c of fanoutBranchClosures(graph, parallel)) {
    for (const n of c.nodes) union.add(n);
  }
  return union;
}
