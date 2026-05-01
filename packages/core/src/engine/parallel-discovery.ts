// Parallel fan-in discovery — attractor-spec §4.8 / §4.9.
//
// Per attractor §4.8, branches are sub-executions that terminate at the
// converging `tripleoctagon` (parallel.fan_in) node. The fan-in target
// is identified STRUCTURALLY via edges, not via a swarm-only `fan_in`
// node attribute. This module walks the graph to find the canonical
// fan-in target and validates that every branch converges on it.
//
// Algorithm:
//   - Branches = direct outgoing edges from the parallel (component) node.
//   - For each branch, find tripleoctagon nodes reachable from the branch
//     start node along forward edges (depth-first, cycle-safe).
//   - The fan-in target is the unique tripleoctagon present in ALL
//     branches' reachable sets. Zero or multiple intersections → ambiguous.

import type { Graph } from "../types/graph.ts";

export type DiscoveryResult =
  | { kind: "ok"; fanInNode: string; branches: string[] }
  | { kind: "no-branches" }
  | { kind: "no-fan-in" }
  | { kind: "ambiguous-fan-in"; candidates: string[] }
  | { kind: "branches-diverge"; branchTargets: Record<string, string[]> };

/** Reachable tripleoctagon node ids from `start`, following forward edges.
 * Cycle-safe (visited set). Stops at any tripleoctagon (it's a terminal
 * for branch traversal — branches don't execute the fan-in node itself). */
export function reachableFanInNodes(graph: Graph, start: string): Set<string> {
  const out = new Set<string>();
  const visited = new Set<string>([start]);
  const stack: string[] = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const node = graph.nodes[id];
    if (node?.shape === "tripleoctagon" && id !== start) {
      out.add(id);
      continue; // don't traverse past the fan-in
    }
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}

/** Determine the fan-in target for a parallel (component) node by
 * intersecting the reachable-tripleoctagon sets of every branch. */
export function discoverFanInTarget(graph: Graph, parallelNodeId: string): DiscoveryResult {
  const branches = graph.edges.filter((e) => e.from === parallelNodeId).map((e) => e.to);
  if (branches.length === 0) return { kind: "no-branches" };

  const perBranch: Record<string, Set<string>> = {};
  for (const b of branches) {
    perBranch[b] = reachableFanInNodes(graph, b);
  }

  // Intersect every branch's reachable set.
  let common: Set<string> | null = null;
  for (const b of branches) {
    const set = perBranch[b];
    if (set === undefined) continue;
    if (common === null) {
      common = new Set(set);
    } else {
      const next = new Set<string>();
      for (const id of common) if (set.has(id)) next.add(id);
      common = next;
    }
  }

  if (common === null || common.size === 0) {
    // Did any branch find a fan-in at all?
    const anyFound = branches.some((b) => (perBranch[b]?.size ?? 0) > 0);
    if (!anyFound) return { kind: "no-fan-in" };
    const branchTargets: Record<string, string[]> = {};
    for (const b of branches) branchTargets[b] = [...(perBranch[b] ?? [])];
    return { kind: "branches-diverge", branchTargets };
  }

  if (common.size > 1) {
    return { kind: "ambiguous-fan-in", candidates: [...common].sort() };
  }

  return { kind: "ok", fanInNode: [...common][0]!, branches };
}

/** Reverse lookup: given a tripleoctagon id, find the parallel (component)
 * node whose branches converge on it. Walks backwards through incoming
 * edges, finding component nodes whose forward discovery resolves here. */
export function findParallelParent(graph: Graph, fanInNodeId: string): string | null {
  for (const node of Object.values(graph.nodes)) {
    if (node.shape !== "component") continue;
    const result = discoverFanInTarget(graph, node.id);
    if (result.kind === "ok" && result.fanInNode === fanInNodeId) return node.id;
  }
  return null;
}
