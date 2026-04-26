// Event-driven overlay for the run-detail snapshot.
//
// Mirrors the server's `runStateToDetail` derivations (`deriveNodeStates`,
// `deriveSelectedEdges`) so the client can update the live UI from SSE
// events directly — no per-frame `qc.refetchQueries(detail)` storm.
//
// Pattern: the snapshot is fetched ONCE at mount (it carries every event
// up to `lastEventSeq`). SSE then resumes from `sinceSeq = lastEventSeq`,
// so every fold below operates on events the snapshot didn't include.
// `mergeDetail(snapshot, overlay)` is the read-side projection consumers
// observe.
//
// Folds are pure and additive — same shape as `foldCostFrame` in
// `useLiveCostAggregate.ts`.

import type { NodeState, RunDetail, SelectedEdge } from "./api.ts";

/** UI-side run statuses. Exact strings match `RunDetail["status"]`. */
type UiStatus = RunDetail["status"];

export interface DetailOverlay {
  /** nodeId → most recent state derived from `fact.node_*` events. */
  nodeStates: Map<string, { state: NodeState["state"]; lastEventSeq: number }>;
  /** `edge.selected` events appended in order. Snapshot already includes
   * its own; the overlay only carries events with seq > snapshot.lastEventSeq.
   * `mergeDetail` concatenates rather than dedupes. */
  selectedEdges: SelectedEdge[];
  /** Latest run-level status from `fact.run_*` events; null when no
   * status-changing event has arrived since mount. */
  status: UiStatus | null;
  /** Seq of the first run-terminal fact (halted/cancelled/quarantined).
   * Used to downgrade still-"running" nodes to "failed" on merge,
   * matching the server's terminal-halt patch. */
  haltSeq: number | undefined;
}

export const EMPTY_DETAIL_OVERLAY: DetailOverlay = {
  nodeStates: new Map(),
  selectedEdges: [],
  status: null,
  haltSeq: undefined,
};

/** Returns true if the event type is one that affects detail-level
 * state (nodes, edges, status). Lets `useRunLive` skip the fold call
 * for hot-path observability events (text deltas) where it'd be a no-op. */
export function isDetailEvent(type: string): boolean {
  return DETAIL_TYPES.has(type);
}

const DETAIL_TYPES = new Set<string>([
  "fact.node_started",
  "fact.node_completed",
  "fact.node_aborted",
  "edge.selected",
  "fact.run_started",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
  "fact.run_paused_hitl",
  "fact.run_resumed",
]);

/** Add a single event onto an existing overlay. Pure — returns a new
 * `DetailOverlay`. Unknown event types short-circuit to `prev`. */
export function foldDetailFrame(
  prev: DetailOverlay,
  type: string,
  payload: Record<string, unknown> | null,
  seq: number,
): DetailOverlay {
  switch (type) {
    case "fact.node_started":
      return setNodeState(prev, payload, "running", seq);
    case "fact.node_completed": {
      const outcome = stringField(payload, "outcomeStatus");
      return setNodeState(prev, payload, outcome === "fail" ? "failed" : "completed", seq);
    }
    case "fact.node_aborted":
      return setNodeState(prev, payload, "failed", seq);
    case "edge.selected": {
      const from = stringField(payload, "from");
      const to = stringField(payload, "to");
      if (from === undefined || to === undefined) return prev;
      return { ...prev, selectedEdges: [...prev.selectedEdges, { from, to }] };
    }
    case "fact.run_started":
      return { ...prev, status: "running" };
    case "fact.run_completed":
      return { ...prev, status: "success" };
    case "fact.run_halted":
      return { ...prev, status: "fail", haltSeq: prev.haltSeq ?? seq };
    case "fact.run_cancelled":
      return { ...prev, status: "canceled", haltSeq: prev.haltSeq ?? seq };
    case "fact.run_quarantined":
      return { ...prev, status: "fail", haltSeq: prev.haltSeq ?? seq };
    case "fact.run_paused_hitl":
      return { ...prev, status: "paused" };
    case "fact.run_resumed":
      return { ...prev, status: "running" };
    default:
      return prev;
  }
}

function setNodeState(
  prev: DetailOverlay,
  payload: Record<string, unknown> | null,
  state: NodeState["state"],
  seq: number,
): DetailOverlay {
  const nodeId = stringField(payload, "nodeId");
  if (nodeId === undefined) return prev;
  const next = new Map(prev.nodeStates);
  next.set(nodeId, { state, lastEventSeq: seq });
  return { ...prev, nodeStates: next };
}

function stringField(payload: Record<string, unknown> | null, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Project the snapshot through the overlay so consumers read a single
 * `RunDetail` regardless of where the data came from. The snapshot
 * carries everything up to `snapshot.lastEventSeq`; the overlay only
 * mutates fields that move during a live run.
 *
 * Per-node merge rule: overlay wins iff its `lastEventSeq` is at least
 * the snapshot row's. Mid-snapshot overlay events (which shouldn't
 * happen — SSE resumes after `lastEventSeq`) are a defensive no-op. */
export function mergeDetail(snapshot: RunDetail, overlay: DetailOverlay): RunDetail {
  // Bail when the overlay is empty — saves a useless object/array clone.
  if (
    overlay.nodeStates.size === 0 &&
    overlay.selectedEdges.length === 0 &&
    overlay.status === null &&
    overlay.haltSeq === undefined
  ) {
    return snapshot;
  }

  const seen = new Set<string>();
  const nodes: NodeState[] = snapshot.nodes.map((n) => {
    seen.add(n.nodeId);
    const ov = overlay.nodeStates.get(n.nodeId);
    return ov && ov.lastEventSeq >= n.lastEventSeq
      ? { nodeId: n.nodeId, state: ov.state, lastEventSeq: ov.lastEventSeq }
      : n;
  });
  for (const [nodeId, ov] of overlay.nodeStates) {
    if (!seen.has(nodeId)) {
      nodes.push({ nodeId, state: ov.state, lastEventSeq: ov.lastEventSeq });
    }
  }

  // Terminal-halt patch: any node still "running" + the run halted →
  // "failed". Mirrors `deriveNodeStates`.
  if (overlay.haltSeq !== undefined) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.state === "running") {
        nodes[i] = { nodeId: n.nodeId, state: "failed", lastEventSeq: overlay.haltSeq };
      }
    }
  }

  return {
    ...snapshot,
    nodes,
    selectedEdges:
      overlay.selectedEdges.length > 0 ? [...snapshot.selectedEdges, ...overlay.selectedEdges] : snapshot.selectedEdges,
    status: overlay.status ?? snapshot.status,
  };
}
