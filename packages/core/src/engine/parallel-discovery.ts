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

/**
 * Well-formedness of a multi-node branch subgraph (P3.1 / W017 of
 * `docs/proposals/parallel.md`). For each branch:
 *
 *   - BFS forward from the branch root, stopping at the fan_in
 *     convergence node.
 *   - The collected node set is the branch's subgraph.
 *   - Different branches' subgraphs MUST be disjoint (no cross-branch
 *     edges): a node reachable from branch A and branch B is ambiguous
 *     ownership and the executor's per-sub-run slice can't decide which
 *     sub-run dispatches it.
 *   - Cycles inside a branch subgraph are tolerated only via the same
 *     retry-policy semantics top-level workflows use (max_retries on
 *     backward edges); detection here just records the cycle.
 */
export type BranchSubgraphFinding =
  | { kind: "ok" }
  | { kind: "cross-branch"; nodeId: string; branchRoots: string[] }
  | { kind: "cycle"; nodeId: string; branchRoot: string };

export interface BranchSubgraphReport {
  /** Per-branch-root → node ids reachable inside the branch's subgraph
   *  (excluding the fan_in node itself). */
  perBranch: Record<string, string[]>;
  /** Empty array when well-formed. */
  findings: BranchSubgraphFinding[];
}

export function validateBranchSubgraphs(
  graph: Graph,
  branches: readonly string[],
  fanInNode: string,
): BranchSubgraphReport {
  const perBranch: Record<string, string[]> = {};
  const findings: BranchSubgraphFinding[] = [];
  const ownership = new Map<string, string[]>(); // nodeId -> branchRoot[]

  for (const branchRoot of branches) {
    const reachable = new Set<string>();
    const stack: string[] = [branchRoot];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === fanInNode) continue; // fan_in is the convergence; not part of any branch.
      if (reachable.has(id)) {
        findings.push({ kind: "cycle", nodeId: id, branchRoot });
        continue;
      }
      reachable.add(id);
      for (const e of graph.edges) {
        if (e.from !== id) continue;
        if (e.to === fanInNode) continue;
        if (!reachable.has(e.to)) stack.push(e.to);
      }
    }
    perBranch[branchRoot] = [...reachable];
    for (const id of reachable) {
      const owners = ownership.get(id) ?? [];
      if (!owners.includes(branchRoot)) owners.push(branchRoot);
      ownership.set(id, owners);
    }
  }

  for (const [nodeId, owners] of ownership) {
    if (owners.length > 1) {
      findings.push({ kind: "cross-branch", nodeId, branchRoots: owners });
    }
  }

  return { perBranch, findings };
}
