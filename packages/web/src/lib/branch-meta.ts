// Branch metadata derived from the run's event log.
//
// The parallel handler emits `fact.node_started` / `fact.node_completed`
// per branch with `parentNodeId` + `parallelIndex` (since P0 in commits
// 78e3969 + d3eb674). The fan_in handler emits `fan_in.completed` with
// the chosen `winner` branchId. Neither shows up on `RunDetail.nodes`
// or `selectedEdges` — the projection keeps `currentNode` parent-pinned
// during fan-out — so the UI reads the raw event stream to surface:
//
//   - `parentToBranches`        — every branch ever observed under a parent
//   - `activeBranchesByParent`  — branches whose state is currently
//                                 `running` (drives the conversation
//                                 split-tabs and the graph branch glow)
//   - `winnerBranchIds`         — branchIds picked by `fan_in.completed`
//                                 (drives the post-fan_in success accent)
//
// The events query is keyed on `totalEvents` so it refetches whenever the
// SSE stream advances. For runs without parallel sections the maps are
// empty and consumers no-op.
//
// Pure helper `deriveBranchMeta` is exported for tests; the React hook
// `useBranchMeta` wraps it in `useQuery` + `useMemo`.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { NodeState, RunDetail } from "./api.ts";
import { queries } from "./queries.ts";

export interface FanInResult {
  /** The fan_in node's own id — the `tripleoctagon` that did the join.
   *  Distinct from `parentNodeId` (the parallel `component` that
   *  fanned out). Surfaced so the conversation can label the result
   *  panel with the actual fan_in node's name. */
  nodeId: string;
  /** Branch picked as winner. Empty string when `allFailed` is true. */
  winner: string;
  /** Branches in fan_in's ranked order (winner first). */
  rankedOrder: readonly string[];
  /** Every branch ended in failure. The fan_in still emits a result so
   *  downstream nodes can react, but `winner` is meaningless. */
  allFailed: boolean;
}

export interface BranchMeta {
  /** parentNodeId → ordered list of branch nodeIds (declaration order). */
  parentToBranches: ReadonlyMap<string, readonly string[]>;
  /** branchNodeId → its parent component nodeId. */
  branchToParent: ReadonlyMap<string, string>;
  /** parentNodeId → branchIds whose `NodeState.state === "running"`. */
  activeBranchesByParent: ReadonlyMap<string, readonly string[]>;
  /** Every branchId picked as winner by a `fan_in.completed` event. */
  winnerBranchIds: ReadonlySet<string>;
  /** parallelNodeId → fan_in result. A heuristic fan_in (no `prompt`)
   *  produces no LLM messages and would otherwise leave the operator
   *  with no record of the join's conclusion; surfacing the winner +
   *  ranked order keeps the parallel section legible end-to-end. */
  fanInResultsByParent: ReadonlyMap<string, FanInResult>;
}

const EMPTY_BRANCH_META: BranchMeta = {
  parentToBranches: new Map(),
  branchToParent: new Map(),
  activeBranchesByParent: new Map(),
  winnerBranchIds: new Set(),
  fanInResultsByParent: new Map(),
};

interface MinimalEvent {
  type: string;
  payload: unknown;
}

/** Pure derivation — exported so tests can exercise it without React. */
export function deriveBranchMeta(events: readonly MinimalEvent[], nodes: readonly NodeState[] | undefined): BranchMeta {
  const parentToBranches = new Map<string, string[]>();
  const branchToParent = new Map<string, string>();
  const winnerBranchIds = new Set<string>();
  const fanInResultsByParent = new Map<string, FanInResult>();
  const seenBranches = new Set<string>();
  const branchStateByNode = new Map<string, NodeState["state"]>();

  for (const ev of events) {
    if (ev.type !== "fact.node_started" && ev.type !== "fact.node_completed" && ev.type !== "fan_in.completed") {
      continue;
    }
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "fan_in.completed") {
      const w = p["winner"];
      if (typeof w === "string" && w.length > 0) winnerBranchIds.add(w);
      const parallelNodeId = typeof p["parallelNodeId"] === "string" ? (p["parallelNodeId"] as string) : "";
      const fanInNodeId =
        typeof p["fanInNodeId"] === "string"
          ? (p["fanInNodeId"] as string)
          : typeof p["nodeId"] === "string"
            ? (p["nodeId"] as string)
            : "";
      if (parallelNodeId && fanInNodeId) {
        const ranked = Array.isArray(p["rankedOrder"])
          ? (p["rankedOrder"] as unknown[]).filter((v): v is string => typeof v === "string")
          : [];
        fanInResultsByParent.set(parallelNodeId, {
          nodeId: fanInNodeId,
          winner: typeof w === "string" ? w : "",
          rankedOrder: ranked,
          allFailed: p["allFailed"] === true,
        });
      }
      continue;
    }
    const nodeId = typeof p["nodeId"] === "string" ? (p["nodeId"] as string) : "";
    const parentNodeId = typeof p["parentNodeId"] === "string" ? (p["parentNodeId"] as string) : "";
    if (!nodeId || !parentNodeId) continue;
    if (ev.type === "fact.node_started") {
      branchStateByNode.set(nodeId, "running");
    } else {
      const outcomeStatus = typeof p["outcomeStatus"] === "string" ? p["outcomeStatus"] : "";
      branchStateByNode.set(nodeId, outcomeStatus === "fail" ? "failed" : "completed");
    }
    if (!seenBranches.has(nodeId)) {
      seenBranches.add(nodeId);
      branchToParent.set(nodeId, parentNodeId);
      const arr = parentToBranches.get(parentNodeId) ?? [];
      arr.push(nodeId);
      parentToBranches.set(parentNodeId, arr);
    }
  }

  const stateByNode = new Map<string, NodeState["state"]>();
  for (const n of nodes ?? []) stateByNode.set(n.nodeId, n.state);
  for (const [nodeId, state] of branchStateByNode) stateByNode.set(nodeId, state);

  const activeBranchesByParent = new Map<string, string[]>();
  for (const [parent, branches] of parentToBranches) {
    const active = branches.filter((b) => stateByNode.get(b) === "running");
    if (active.length > 0) activeBranchesByParent.set(parent, active);
  }

  return { parentToBranches, branchToParent, activeBranchesByParent, winnerBranchIds, fanInResultsByParent };
}

/** React hook: fetches the run's events, derives branch metadata.
 *  Re-keys on `totalEvents` so SSE-driven liveness flows through. */
export function useBranchMeta(
  runId: string | null | undefined,
  detail: RunDetail | undefined,
  totalEvents: number,
): BranchMeta {
  const eventsKey = queries.runs.events(runId ?? "").queryKey;
  const eventsQuery = useQuery({
    ...queries.runs.events(runId ?? ""),
    enabled: !!runId,
    refetchInterval: detail?.status === "running" ? 1_000 : false,
  });
  const events = eventsQuery.data?.events;
  const eventsLen = Array.isArray(events) ? events.length : 0;

  const qc = useQueryClient();
  // Invalidate on SSE-driven `totalEvents` changes so the query refetches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalEvents is the deliberate trigger; eventsKey + qc are stable.
  useEffect(() => {
    if (runId) void qc.invalidateQueries({ queryKey: eventsKey });
  }, [totalEvents, runId]);

  // eslint-disable-next-line — eventsLen is the cheap identity-stable
  // signal; the events array reference changes on every refetch even
  // when the content is identical, so depending on it directly would
  // re-derive the maps unnecessarily. eventsLen captures the only
  // dimension we care about for invalidation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  return useMemo(() => {
    if (!Array.isArray(events) || events.length === 0) return EMPTY_BRANCH_META;
    return deriveBranchMeta(events as MinimalEvent[], detail?.nodes);
  }, [eventsLen, detail?.nodes]);
}
