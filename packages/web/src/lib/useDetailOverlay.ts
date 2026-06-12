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

import { HALT_REASONS, type HaltReason } from "@fragua/types";
import type { NodeState, RunDetail, SelectedEdge } from "./api.ts";

/** UI-side run statuses. Exact strings match `RunDetail["status"]`. */
type UiStatus = RunDetail["status"];

export interface DetailOverlay {
  /** `${nodeId}#${pass}.${iteration}` → most recent state derived from
   * `fact.node_*` events — the same key the server's `deriveNodeStates`
   * uses. Keyed by pass + iteration so loops (backward edges) AND goal-gate
   * re-entries keep one entry per execution instead of last-write-wins. */
  nodeStates: Map<
    string,
    { nodeId: string; iteration: number; pass: number; state: NodeState["state"]; lastEventSeq: number }
  >;
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
  /** Raw run status, for distinguishing paused_human vs paused. */
  runStatus: RunDetail["runStatus"] | null;
  /** Node id of the active human-node gate (from fact.run_paused_human). */
  hitlNodeId: string | null;
  /** Operator-facing question text from the paused human node's `text=` attr. */
  hitlLabel: string | null;
  /** Declared route names from the paused human node's `routes=` attr;
   *  one button rendered per route. Field name retained for back-compat
   *  with `RunDetail.hitlOptions` consumers; values are now plain route
   *  names per the §D6 payload shape. */
  hitlOptions: string[] | null;
  /** Sparse route-name → button-text map from the paused human node's edge
   *  `label=` overrides (D6). Null until a `fact.run_paused_human` carrying
   *  `routeLabels` arrives; routes absent from the map fall back to
   *  `humanizeRouteName`. */
  hitlOptionLabels: Record<string, string> | null;
  /** Per-node route (+ optional note) the operator chose at each answered
   *  human gate, accumulated from `intent.human_input` paired with the
   *  open gate's `hitlNodeId`. Null until the first decision lands; never
   *  cleared on resume so the decision banner persists. */
  hitlDecisions: Record<string, { route: string; note?: string }> | null;
  /** Seq of the first run-terminal fact (halted/cancelled/quarantined).
   * Used to downgrade still-"running" nodes to "failed" on merge,
   * matching the server's terminal-halt patch. */
  haltSeq: number | undefined;
  /** Terminal diagnosis from a live `fact.run_halted` — mirrors the
   * read-plane's `haltReason` / `haltDetail` projection so the halted
   * banner appears without a refetch. Null until a halt fact arrives. */
  haltReason: HaltReason | null;
  haltDetail: string | null;
  /** Seq of the latest run-LEVEL status fact folded (run_started / paused /
   * paused_human / resumed / completed / halted / cancelled / quarantined).
   * `mergeDetail` gates the overlay's run-level fields (status, runStatus,
   * hitl*) on this being newer than the snapshot — mirroring the per-node
   * `lastEventSeq` gating. Without it a stale overlay (e.g. one that missed
   * a `fact.run_resumed` SSE frame) would pin the page to `paused_human`
   * even after the snapshot refetched and advanced past the pause. */
  runStateSeq: number | undefined;
}

export const EMPTY_DETAIL_OVERLAY: DetailOverlay = {
  nodeStates: new Map(),
  selectedEdges: [],
  status: null,
  runStatus: null,
  hitlNodeId: null,
  hitlLabel: null,
  hitlOptions: null,
  hitlOptionLabels: null,
  hitlDecisions: null,
  haltSeq: undefined,
  haltReason: null,
  haltDetail: null,
  runStateSeq: undefined,
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
  "fact.fanout_started",
  "fact.fanout_joined",
  "fact.node_completed",
  "fact.node_aborted",
  "edge.selected",
  "fact.run_started",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
  "fact.run_paused_human",
  "fact.run_paused",
  "fact.run_resumed",
  "intent.human_input",
]);

/** Run-LEVEL status facts — those that move `status` / `runStatus` / the
 * hitl gate. The latest such seq is stamped onto `runStateSeq` so
 * `mergeDetail` can tell whether the overlay's run-level view is fresher
 * than a refetched snapshot. */
const RUN_STATUS_FACTS = new Set<string>([
  "fact.run_started",
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
  "fact.run_paused",
  "fact.run_paused_human",
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
  const next = foldDetailFrameInner(prev, type, payload, seq);
  return RUN_STATUS_FACTS.has(type) ? { ...next, runStateSeq: seq } : next;
}

function foldDetailFrameInner(
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
    case "fact.fanout_started": {
      // A parallel node's branch ENTRIES are seeded into the active set here;
      // they never emit node_started/dispatch_started (that would unpin the run
      // pointer from the parallel node), so mark them running directly — the
      // graph glows them and the conversation groups their live streams.
      const branches = Array.isArray(payload?.["branches"]) ? (payload["branches"] as string[]) : [];
      // The parallel node itself runs for the whole region (it never emits
      // node_started/node_completed of its own) — mark it running alongside
      // its branches, mirroring the server's deriveNodeStates.
      let next = setNodeState(prev, payload, "running", seq);
      // Branch entries inherit the region's pass (a goal-gate re-entry
      // re-seeds the whole fan-out at the bumped epoch).
      const regionPass = payload?.["pass"];
      for (const b of branches) next = setNodeState(next, { nodeId: b, pass: regionPass }, "running", seq);
      return next;
    }
    case "fact.fanout_joined":
      // The barrier completes the parallel node's region-wide entry.
      return setNodeState(prev, payload, "completed", seq);
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
      const pass = numberField(payload, "pass") ?? 0;
      return { ...prev, selectedEdges: [...prev.selectedEdges, { from, to, iteration, pass, seq }] };
    }
    case "fact.run_started":
      return { ...prev, status: "running" };
    case "fact.run_completed":
      return { ...prev, status: "success" };
    case "fact.run_halted": {
      const reason = stringField(payload, "reason");
      const haltReason =
        reason !== undefined && (HALT_REASONS as readonly string[]).includes(reason) ? (reason as HaltReason) : null;
      return {
        ...prev,
        status: "fail",
        runStatus: "halted",
        haltSeq: prev.haltSeq ?? seq,
        haltReason,
        haltDetail: stringField(payload, "detail") ?? null,
      };
    }
    case "fact.run_cancelled":
      return { ...prev, status: "canceled", haltSeq: prev.haltSeq ?? seq };
    case "fact.run_quarantined":
      return { ...prev, status: "fail", haltSeq: prev.haltSeq ?? seq };
    case "fact.run_paused_human": {
      // Payload shape: human nodes yield `{ text, routes }` (operator
      // question + declared routes).
      // The route names drive the per-button enum that the operator
      // POSTs back via /runs/:id/human { route, note? }.
      const nodeId = stringField(payload, "nodeId");
      const text = stringField(payload, "text");
      const rawRoutes = payload?.["routes"];
      const routes =
        Array.isArray(rawRoutes) && rawRoutes.every((r) => typeof r === "string") ? (rawRoutes as string[]) : null;
      const rawLabels = payload?.["routeLabels"];
      let routeLabels: Record<string, string> | null = null;
      if (rawLabels != null && typeof rawLabels === "object" && !Array.isArray(rawLabels)) {
        const labels: Record<string, string> = {};
        for (const [route, label] of Object.entries(rawLabels as Record<string, unknown>)) {
          if (typeof label === "string") labels[route] = label;
        }
        if (Object.keys(labels).length > 0) routeLabels = labels;
      }
      // Reset the paused node back to "running" — the prior fact.node_aborted
      // (in the operator-pause path) optimistically flipped it to "failed",
      // but a paused node will re-dispatch on resume. Workflow-driven
      // human nodes don't emit a preceding node_aborted but a running-set
      // is harmless.
      const nextOverlay = nodeId != null ? setNodeState(prev, { nodeId }, "running", seq) : prev;
      return {
        ...nextOverlay,
        status: "paused",
        runStatus: "paused_human",
        hitlNodeId: nodeId ?? null,
        hitlLabel: text ?? null,
        hitlOptions: routes,
        hitlOptionLabels: routeLabels,
      };
    }
    case "intent.human_input": {
      // The operator's answer to the currently-open gate. The intent
      // carries `{ route, note? }` but not the node id — the gate it
      // answers is whichever `fact.run_paused_human` is open, i.e.
      // `prev.hitlNodeId`. Record it per-node; never cleared on resume so
      // the decision banner outlives the gate.
      const route = stringField(payload, "route");
      const gateNode = prev.hitlNodeId;
      if (route == null || gateNode == null) return prev;
      const note = stringField(payload, "note");
      const decision = note != null ? { route, note } : { route };
      return { ...prev, hitlDecisions: { ...(prev.hitlDecisions ?? {}), [gateNode]: decision } };
    }
    case "fact.run_paused": {
      // Reason carries on the payload; the reducer projects status to
      // `paused_auto` for AUTO_WAKE_PAUSE_REASONS (provider_retry /
      // handler_retry), `paused` otherwise. The auto-wake projection
      // doesn't ride this overlay path — it goes through the
      // auto-resume sweep — so the reasons we can see here are
      // operator-resumable: operator / provider_error / payment_required
      // / budget. Set runStatus to `paused`; banner reads the reason
      // from the latest fact payload.
      //
      // The pause's node was flipped to "failed" by the preceding
      // fact.node_aborted, but a paused node re-dispatches on resume — it's
      // suspended, not failed. Reset it to "running" (the UI renders
      // running + paused as "paused"), mirroring the human-pause path above.
      const nodeId = stringField(payload, "nodeId");
      const nextOverlay = nodeId != null ? setNodeState(prev, { nodeId }, "running", seq) : prev;
      return { ...nextOverlay, status: "paused", runStatus: "paused" };
    }
    case "fact.run_resumed":
      return {
        ...prev,
        status: "running",
        runStatus: "running",
        hitlNodeId: null,
        hitlLabel: null,
        hitlOptions: null,
        hitlOptionLabels: null,
      };
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
  const pass = numberField(payload, "pass") ?? 0;
  const next = new Map(prev.nodeStates);
  next.set(stateKey(nodeId, pass, iteration), { nodeId, iteration, pass, state, lastEventSeq: seq });
  return { ...prev, nodeStates: next };
}

function stateKey(nodeId: string, pass: number, iteration: number): string {
  return `${nodeId}#${pass}.${iteration}`;
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
    overlay.hitlOptionLabels === null &&
    overlay.hitlDecisions === null &&
    overlay.haltSeq === undefined &&
    overlay.haltReason === null &&
    overlay.haltDetail === null
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
    const key = stateKey(n.nodeId, n.pass ?? 0, n.iteration);
    seen.add(key);
    const ov = overlay.nodeStates.get(key);
    if (ov && ov.lastEventSeq >= n.lastEventSeq) {
      nodesChanged = true;
      return {
        nodeId: n.nodeId,
        iteration: n.iteration,
        pass: ov.pass,
        state: ov.state,
        lastEventSeq: ov.lastEventSeq,
      };
    }
    return n;
  });
  for (const [key, ov] of overlay.nodeStates) {
    if (!seen.has(key)) {
      nodes.push({
        nodeId: ov.nodeId,
        iteration: ov.iteration,
        pass: ov.pass,
        state: ov.state,
        lastEventSeq: ov.lastEventSeq,
      });
      nodesChanged = true;
    }
  }

  // Terminal-halt patch: any node still "running" + the run halted →
  // "failed". Mirrors `deriveNodeStates`.
  if (overlay.haltSeq !== undefined) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.state === "running") {
        nodes[i] = { ...n, state: "failed", lastEventSeq: overlay.haltSeq };
        nodesChanged = true;
      }
    }
  }

  // The overlay's run-level view is authoritative only while it reflects a
  // fact newer than the snapshot's frontier (mirrors the per-node gating
  // above). At/under the frontier the refetched snapshot wins.
  const overlayRunFresh = overlay.runStateSeq !== undefined && overlay.runStateSeq > snapshot.lastEventSeq;

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
        ...fresh.map(({ from, to, iteration, pass }) => ({ from, to, iteration, pass })),
      ];
    })(),
    // Run-level fields win from the overlay ONLY while it's fresher than
    // the snapshot. Once the snapshot refetches past the overlay's latest
    // run-state fact, the snapshot is authoritative — so a stale overlay
    // (e.g. one that missed a `fact.run_resumed` frame) can't pin the page
    // to a pause the run has already left.
    status: overlayRunFresh ? (overlay.status ?? snapshot.status) : snapshot.status,
    runStatus: overlayRunFresh && overlay.runStatus !== null ? overlay.runStatus : snapshot.runStatus,
    haltReason: overlayRunFresh && overlay.haltReason !== null ? overlay.haltReason : snapshot.haltReason,
    haltDetail: overlayRunFresh && overlay.haltDetail !== null ? overlay.haltDetail : snapshot.haltDetail,
    hitlNodeId: overlayRunFresh && overlay.hitlNodeId !== null ? overlay.hitlNodeId : snapshot.hitlNodeId,
    hitlLabel: overlayRunFresh && overlay.hitlLabel !== null ? overlay.hitlLabel : snapshot.hitlLabel,
    hitlOptions: overlayRunFresh && overlay.hitlOptions !== null ? overlay.hitlOptions : snapshot.hitlOptions,
    hitlOptionLabels:
      overlayRunFresh && overlay.hitlOptionLabels !== null ? overlay.hitlOptionLabels : snapshot.hitlOptionLabels,
    // Live decisions layer over the snapshot's history, latest per node.
    hitlDecisions:
      overlay.hitlDecisions !== null
        ? { ...(snapshot.hitlDecisions ?? {}), ...overlay.hitlDecisions }
        : snapshot.hitlDecisions,
  };
}
