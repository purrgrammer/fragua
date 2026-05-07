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
  /** `${nodeId}#${iteration}` → most recent state derived from `fact.node_*`
   * events. Keyed by iteration too so loops (backward edges, goal-gate
   * retargets) keep one entry per re-entry instead of last-write-wins. */
  nodeStates: Map<string, { nodeId: string; iteration: number; state: NodeState["state"]; lastEventSeq: number }>;
  /** `edge.selected` events appended in order, each tagged with its own
   * `seq`. Snapshot already includes every edge through
   * `snapshot.lastEventSeq`; this overlay accumulates from-mount onwards
   * regardless of the live snapshot's seq frontier (the consumer doesn't
   * trim on snapshot refetch). `mergeDetail` therefore filters
   * `e.seq > snapshot.lastEventSeq` before concatenation — without this,
   * any snapshot refresh that catches up to overlay events double-counts
   * them and the run-detail Graph view shows `· ×2` on every edge. */
  selectedEdges: Array<SelectedEdge & { seq: number }>;
  /** Latest run-level status from `fact.run_*` events; null when no
   * status-changing event has arrived since mount. */
  status: UiStatus | null;
  /** Raw run status, for distinguishing paused_hitl vs paused. */
  runStatus: RunDetail["runStatus"] | null;
  /** Node id of the active HITL gate (from fact.run_paused_hitl). */
  hitlNodeId: string | null;
  /** Question label for the active HITL gate. */
  hitlLabel: string | null;
  /** Structured choices for the active HITL gate. */
  hitlOptions: Array<{ key: string; label: string; to: string }> | null;
  /** Seq of the first run-terminal fact (halted/cancelled/quarantined).
   * Used to downgrade still-"running" nodes to "failed" on merge,
   * matching the server's terminal-halt patch. */
  haltSeq: number | undefined;
}

export const EMPTY_DETAIL_OVERLAY: DetailOverlay = {
  nodeStates: new Map(),
  selectedEdges: [],
  status: null,
  runStatus: null,
  hitlNodeId: null,
  hitlLabel: null,
  hitlOptions: null,
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
  "fact.dispatch_started",
  "fact.node_completed",
  "fact.node_aborted",
  "edge.selected",
  "fact.run_started",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
  "fact.run_paused_hitl",
  "fact.run_paused",
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
    // `dispatch_started` fires on every dispatch (including resume from
    // operator-pause). Resets the node back to running even if it was
    // optimistically marked "failed" by a prior `node_aborted`.
    case "fact.dispatch_started":
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
      const iteration = numberField(payload, "iteration") ?? 0;
      return { ...prev, selectedEdges: [...prev.selectedEdges, { from, to, iteration, seq }] };
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
    case "fact.run_paused_hitl": {
      const nodeId = stringField(payload, "nodeId");
      const label = stringField(payload, "label");
      const rawOptions = payload?.["options"];
      const options = Array.isArray(rawOptions)
        ? (rawOptions as Array<{ key: string; label: string; to: string }>)
        : null;
      // Reset the paused node back to "running" — the prior fact.node_aborted
      // (in the operator-pause path) optimistically flipped it to "failed",
      // but a paused node will re-dispatch on resume. Workflow-driven
      // wait.human nodes don't emit a preceding node_aborted but a
      // running-set is harmless.
      const nextOverlay = nodeId != null ? setNodeState(prev, { nodeId }, "running", seq) : prev;
      return {
        ...nextOverlay,
        status: "paused",
        runStatus: "paused_hitl",
        hitlNodeId: nodeId ?? null,
        hitlLabel: label ?? null,
        hitlOptions: options,
      };
    }
    case "fact.run_paused": {
      // Reason carries on the payload; status is `paused` at the wire
      // level (the reducer projects auto-retry-policy provider errors
      // to `paused_provider_retry`, but those don't ride this overlay
      // path — they go through the auto-resume sweep). Operator-driven
      // pauses (reason:"operator") and budget pauses arrive here too,
      // so we can't unconditionally route to `paused_hitl`.
      return { ...prev, status: "paused", runStatus: "paused" };
    }
    case "fact.run_resumed":
      return { ...prev, status: "running", runStatus: "running", hitlNodeId: null, hitlLabel: null, hitlOptions: null };
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
  const iteration = numberField(payload, "iteration") ?? 0;
  const next = new Map(prev.nodeStates);
  next.set(stateKey(nodeId, iteration), { nodeId, iteration, state, lastEventSeq: seq });
  return { ...prev, nodeStates: next };
}

function stateKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${iteration}`;
}

function stringField(payload: Record<string, unknown> | null, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === "string" ? v : undefined;
}

function numberField(payload: Record<string, unknown> | null, key: string): number | undefined {
  const v = payload?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
    overlay.runStatus === null &&
    overlay.hitlNodeId === null &&
    overlay.hitlLabel === null &&
    overlay.hitlOptions === null &&
    overlay.haltSeq === undefined
  ) {
    return snapshot;
  }

  // Build the merged node list lazily: on overlays that only carry a
  // status flip (e.g. fact.run_completed with no node fact in the same
  // batch) every node in `snapshot.nodes` re-emerges unchanged, but the
  // old code still produced a fresh array via `.map`. Downstream
  // consumers (RunConversation, GraphView) keyed memoisation off
  // `detail.nodes` referentially, so the destabilised array forced
  // every message row to re-render on every overlay tick. Now: track
  // whether any node row actually moved; if not, reuse `snapshot.nodes`.
  const seen = new Set<string>();
  let nodesChanged = false;
  const nodes: NodeState[] = snapshot.nodes.map((n) => {
    const key = `${n.nodeId}#${n.iteration}`;
    seen.add(key);
    const ov = overlay.nodeStates.get(key);
    if (ov && ov.lastEventSeq >= n.lastEventSeq) {
      nodesChanged = true;
      return { nodeId: n.nodeId, iteration: n.iteration, state: ov.state, lastEventSeq: ov.lastEventSeq };
    }
    return n;
  });
  for (const [key, ov] of overlay.nodeStates) {
    if (!seen.has(key)) {
      nodes.push({ nodeId: ov.nodeId, iteration: ov.iteration, state: ov.state, lastEventSeq: ov.lastEventSeq });
      nodesChanged = true;
    }
  }

  // Terminal-halt patch: any node still "running" + the run halted →
  // "failed". Mirrors `deriveNodeStates`.
  if (overlay.haltSeq !== undefined) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.state === "running") {
        nodes[i] = { nodeId: n.nodeId, iteration: n.iteration, state: "failed", lastEventSeq: overlay.haltSeq };
        nodesChanged = true;
      }
    }
  }

  return {
    ...snapshot,
    nodes: nodesChanged ? nodes : snapshot.nodes,
    selectedEdges: (() => {
      // Drop overlay edges already represented in the snapshot. Without
      // this filter, every refetch of the snapshot that catches up to
      // events the overlay has accumulated produces duplicates —
      // surfacing as a `· ×N` traversal-count badge on edges that fired
      // exactly once.
      const fresh = overlay.selectedEdges.filter((e) => e.seq > snapshot.lastEventSeq);
      if (fresh.length === 0) return snapshot.selectedEdges;
      return [
        ...snapshot.selectedEdges,
        ...fresh.map(({ from, to, iteration }) => ({ from, to, iteration })),
      ];
    })(),
    status: overlay.status ?? snapshot.status,
    runStatus: overlay.runStatus !== null ? overlay.runStatus : snapshot.runStatus,
    hitlNodeId: overlay.hitlNodeId !== null ? overlay.hitlNodeId : snapshot.hitlNodeId,
    hitlLabel: overlay.hitlLabel !== null ? overlay.hitlLabel : snapshot.hitlLabel,
    hitlOptions: overlay.hitlOptions !== null ? overlay.hitlOptions : snapshot.hitlOptions,
  };
}
