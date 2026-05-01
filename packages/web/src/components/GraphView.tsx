// GraphView — renders a swarm workflow graph using Vercel AI Elements
// (`Canvas`, `Node`, `Edge`, `Controls`) on top of `@xyflow/react`.
//
// Two call shapes:
//
//   1. Run-live:  <GraphView runId=… />           (or detail=…)
//      Topology from `RunDetail.workflowSource`, lifecycle state
//      from `detail.nodes[]`. Edges animate while the run is running.
//
//   2. Workflow-detail:  <GraphView graph=… source=… />
//      Topology from an already-parsed `Graph`. No lifecycle state:
//      every node renders neutral. The workflow detail route uses this
//      to inspect a `.dot` file without needing a run.
//
// Data path notes:
//   - Topology is ALWAYS parsed from DOT via `@swarm/core`'s
//     `parseDotSource` — the same parser the runtime uses. One source
//     of truth, zero risk of drift.
//   - There is NO `detail.edges` field on the server — topology lives
//     in the DOT source and is parsed client-side. Reject any PR that
//     tries to add one.
//   - Flow is top-to-bottom by default (`orientation="TB"`). Callers
//     can ask for `"LR"` when they need the horizontal strip.
//
// Node DOM contract: each rendered node carries `data-node-id="<id>"`
// so existing tests (and any future Playwright) can target them.

import { type Graph, type Edge as GraphEdge, type Node as GraphNode, handlerOf, parseDotSource } from "@swarm/core";
import { useQuery } from "@tanstack/react-query";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps as FlowNodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import { useCallback, useMemo } from "react";
import type { NodeState, RunDetail } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { classifyGraph, edgeKey, type LayoutOrientation, layoutDag } from "../lib/graph-layout.ts";
import { queries } from "../lib/queries.ts";
import { Canvas } from "./ai-elements/canvas.tsx";
import { Controls } from "./ai-elements/controls.tsx";
import { Edge as AiEdge } from "./ai-elements/edge.tsx";
import { Node as AiNode, NodeContent, NodeHeader, NodeTitle } from "./ai-elements/node.tsx";
import { EmptyState } from "./ui/empty-state.tsx";

export interface GraphViewProps {
  /** When provided (and no `detail`/`graph`), we fetch `/runs/:runId`. */
  runId?: string;
  /**
   * Pre-fetched run detail. Takes precedence over `runId` — used
   * when the parent is already loading the detail (e.g. RunDetail
   * page). Supplies workflow source AND live lifecycle state.
   */
  detail?: RunDetail;
  /**
   * Pre-parsed topology for the static workflow-detail view. When this
   * is set `detail`/`runId` are ignored and every node renders neutral.
   */
  graph?: Graph;
  /** Click → fires with the `data-node-id` of the clicked node. */
  onNodeClick?: (nodeId: string) => void;
  /**
   * Runtime-active node (the one currently executing). Distinct from
   * `selectedNodeId`: "active" is the workflow's current pointer,
   * "selected" is what the user clicked to inspect.
   */
  activeNodeId?: string | null;
  /** User-selected node — renders a distinct ring so the two signals don't collide. */
  selectedNodeId?: string | null;
  /** Flow direction. Default `"TB"`. */
  orientation?: LayoutOrientation;
  /** Node currently paused at a HITL gate. Renders with "waiting" state
   * so operators can distinguish it from an actively-running node. */
  hitlNodeId?: string | null;
}

const NODE_TYPE = "swarmNode";
const EDGE_TYPE = "swarmEdge";

// Arrowhead used on every edge so flow direction is unambiguous.
// Theme tokens via CSS vars — modern browsers resolve var() in SVG
// presentation attributes, so markers follow light/dark mode.
const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, width: 14, height: 14, color }) as const;
const MARKER_DEFAULT = arrow("var(--sw-border)");
const MARKER_LOOP = arrow("var(--sw-accent-warn)");
const MARKER_ANIMATED = arrow("var(--sw-accent-thinking)");
const MARKER_SUCCESS = arrow("var(--sw-accent-success)");
const MARKER_FAIL = arrow("var(--sw-accent-error)");

// Handle IDs for back-edge / skip-edge routing. These edges enter/exit
// the right side of the node (TB orientation) or the bottom (LR) so
// their arc sits outside the main forward-flow column.
const LOOP_HANDLE_SOURCE = "loop-source";
const LOOP_HANDLE_TARGET = "loop-target";

export function GraphView(props: GraphViewProps): JSX.Element {
  const {
    runId,
    detail: detailProp,
    graph: graphProp,
    onNodeClick,
    activeNodeId,
    selectedNodeId,
    orientation = "TB",
    hitlNodeId,
  } = props;

  // Backstop fetch for the `runId`-only call shape. RunDetail passes
  // `detail` directly (a snapshot+overlay merge that updates live), so
  // this query stays disabled in the hot path. No invalidation effect —
  // live updates come through the parent's merged `detail` prop.
  const query = useQuery({
    ...queries.runs.detail(runId ?? ""),
    enabled: !!runId && !detailProp && !graphProp,
  });

  const readyDetail = detailProp ?? query.data ?? null;
  const isLoading = !detailProp && !graphProp && !!runId && query.isPending;
  const fetchError = !detailProp && !graphProp && !!runId && query.error;

  const graph: Graph | null = useMemo(() => {
    if (graphProp) return graphProp;
    if (!readyDetail?.workflowSource) return null;
    try {
      return parseDotSource(readyDetail.workflowSource);
    } catch (err) {
      console.warn(
        "[GraphView] failed to parse workflow DOT for",
        readyDetail.runId,
        "—",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }, [graphProp, readyDetail?.workflowSource, readyDetail?.runId]);

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!graph) return { flowNodes: [], flowEdges: [] };
    const resolvedHitlNodeId =
      hitlNodeId !== undefined
        ? hitlNodeId
        : readyDetail?.runStatus === "paused_hitl"
          ? (readyDetail.hitlNodeId ?? null)
          : null;
    return toFlowGraph(readyDetail, graph, {
      activeNodeId: activeNodeId ?? null,
      selectedNodeId: selectedNodeId ?? null,
      orientation,
      hitlNodeId: resolvedHitlNodeId,
    });
  }, [readyDetail, graph, activeNodeId, selectedNodeId, orientation, hitlNodeId]);

  const handleNodeClick = useCallback(
    (_e: unknown, node: FlowNode) => {
      onNodeClick?.(node.id);
    },
    [onNodeClick],
  );

  if (isLoading) {
    return (
      <div data-testid="graphview-loading" className="flex min-h-[320px] items-center justify-center">
        <p className="text-sw-sm text-sw-muted">Loading graph…</p>
      </div>
    );
  }

  if (!readyDetail && !runId && !graphProp) {
    return (
      <EmptyState
        data-testid="graphview-empty"
        title="No graph to display"
        description="Pass a runId, a detail, or a graph prop to render."
      />
    );
  }

  if (fetchError) {
    return (
      <EmptyState
        data-testid="graphview-empty"
        title="Graph unavailable"
        description="This run doesn't have a renderable graph yet — the server couldn't return its detail. Check the console for specifics."
      />
    );
  }

  if (!graph) {
    return (
      <EmptyState
        data-testid="graphview-nograph"
        title="No graph available for this run"
        description="The run didn't record its workflow source (older runs may lack it). Try the runs created after P5.13 for a full canvas."
      />
    );
  }

  return (
    <div
      data-testid="graphview"
      data-node-count={flowNodes.length}
      data-orientation={orientation}
      // React Flow needs an explicit height — the canvas fills its parent.
      className="h-full min-h-[480px] w-full rounded-sw-card border border-sw-border bg-sw-surface"
    >
      <Canvas
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
      >
        <Controls />
      </Canvas>
    </div>
  );
}

// ── Node/edge type registrations ─────────────────────────────────────────

// Left-edge colored strip that encodes node archetype. Each distinct
// archetype gets its own hue so a glance across the graph tells you
// the branching/HITL/loop/validation structure without reading labels:
//
//   goal_gate     → success (green)       — "did we land it?"
//   conditional   → warn    (orange)      — explicit decision split
//   wait.human    → human   (steel blue)  — HITL / paused_hitl
//   loop          → loop    (teal)        — iteration / cycling
//   parallel*     → idle    (gray)        — structural fan-out / subtree
//   codergen      → (no strip — neutral baseline)
//
// `goal_gate` wins over handler: a codergen node with goal_gate=true
// acts as a validation gate, which is the more specific signal.
function typeStripTone(handler: string, goalGate: boolean): string | null {
  if (goalGate) return "bg-sw-accent-success";
  switch (handler) {
    case "conditional":
      return "bg-sw-accent-warn";
    case "wait.human":
      return "bg-sw-accent-human";
    case "parallel":
    case "parallel.fan_in":
      return "bg-sw-accent-idle";
    case "tool":
      return "bg-sw-accent-loop";
    default:
      return null;
  }
}

function SwarmNode({ data }: FlowNodeProps): JSX.Element {
  const d = data as SwarmNodeData;
  const handlerLabel = d.handler;
  const stripTone = typeStripTone(handlerLabel, d.goalGate);
  // Extra handles carry back-edges ("loop" returns) so they route around
  // the forward-flow column. In TB flow the arc lives on the right; in
  // LR, on the bottom. xyflow allows multiple handles per node as long
  // as their ids differ.
  const loopPos = d.orientation === "TB" ? Position.Right : Position.Bottom;
  // Surface the DOT `label` in the header only when it carries meaning
  // beyond the id — otherwise the id (shown in the body) would appear
  // twice. Empty title ⇒ header reduces to handler + state dot.
  const hasHeaderTitle = typeof d.customLabel === "string" && d.customLabel.length > 0 && d.customLabel !== d.nodeId;
  return (
    <AiNode
      handles={{ target: d.hasIncoming, source: d.hasOutgoing, orientation: d.orientation }}
      data-node-id={d.nodeId}
      data-state={d.state}
      data-handler={handlerLabel}
      data-dim={d.dim ? "true" : undefined}
      className={cn(
        "relative w-60 overflow-hidden transition-[colors,opacity] duration-[var(--sw-duration-status)]",
        d.dim && "opacity-35",
        d.active && "ring-2 ring-sw-accent-thinking",
        d.selected && !d.active && "ring-2 ring-sw-accent-idle",
      )}
    >
      {stripTone ? (
        <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 left-0 w-[3px]", stripTone)} />
      ) : null}
      {/* Back-edge handles — invisible to the user, routed through by Loop edges. */}
      <Handle id={LOOP_HANDLE_TARGET} position={loopPos} type="target" style={{ opacity: 0 }} />
      <Handle id={LOOP_HANDLE_SOURCE} position={loopPos} type="source" style={{ opacity: 0 }} />
      <NodeHeader className="gap-0.5 p-2!">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sw-xs uppercase tracking-[0.06em] text-sw-muted" title={handlerLabel}>
            {handlerLabel}
          </span>
          {d.state && <StateDot state={d.state} />}
        </div>
        {hasHeaderTitle ? (
          <NodeTitle className="truncate text-sw-sm font-medium text-sw-text" title={d.customLabel}>
            {d.customLabel}
          </NodeTitle>
        ) : null}
      </NodeHeader>
      <NodeContent className="flex flex-col gap-0.5 p-2 text-sw-xs text-sw-muted">
        <span className="truncate" title={d.nodeId}>
          <span className="uppercase tracking-[0.06em]">id</span> <code className="text-sw-text">{d.nodeId}</code>
        </span>
        {d.model ? (
          <span className="truncate" title={d.model}>
            <span className="uppercase tracking-[0.06em]">model</span> <code className="text-sw-text">{d.model}</code>
          </span>
        ) : null}
        {d.lastEventSeq > 0 ? <span>seq {d.lastEventSeq}</span> : null}
      </NodeContent>
    </AiNode>
  );
}

function StateDot({ state }: { state: NodeState["state"] | "waiting" }): JSX.Element {
  const { tone, pulse } = stateStyle(state);
  return (
    <span
      aria-hidden
      title={state}
      className={cn(
        "size-2 shrink-0 rounded-full transition-colors duration-[var(--sw-duration-status)]",
        tone,
        pulse && "sw-pulse",
      )}
    />
  );
}

function stateStyle(state: NodeState["state"] | "waiting"): { tone: string; pulse: boolean } {
  switch (state) {
    case "running":
      return { tone: "bg-sw-accent-thinking", pulse: true };
    case "waiting":
      return { tone: "bg-sw-accent-human", pulse: false };
    case "retrying":
      return { tone: "bg-sw-accent-warn", pulse: true };
    case "completed":
      return { tone: "bg-sw-accent-success", pulse: false };
    case "failed":
      return { tone: "bg-sw-accent-error", pulse: false };
    case "skipped":
    case "pending":
      return { tone: "bg-sw-accent-idle", pulse: false };
    default:
      return { tone: "bg-sw-accent-idle", pulse: false };
  }
}

/**
 * Edge renderer: picks a variant by edge data.
 *   - `Loop` for back-edges (dashed warn arc, points at the earlier step).
 *   - `Temporary` with `arcOut` for forward skip-edges (hairline arc
 *     routed outside the main column so its label doesn't sit behind
 *     intermediate nodes).
 *   - `Animated` for live/running forward edges (pulsing thinking arc).
 *   - `Temporary` for the rest — static dashed hairline, direct path.
 * Loop takes precedence over animated: a running back-edge still reads
 * as a loop first (the direction is the information), not a data stream.
 * `outcome` (if set) overrides the stroke / pill tone — a failure path
 * reads red regardless of the structural variant.
 */
function SwarmEdge(props: FlowEdgeRenderProps): JSX.Element {
  // `data.dim` is threaded down via FlowEdge.data and each edge variant
  // fades both its SVG path and its HTML label pill in lockstep.
  const d = props.data;
  const outcome = d?.outcome;
  if (d?.isBackEdge) return <AiEdge.Loop {...props} outcome={outcome} />;
  if (d?.isSkipEdge) return <AiEdge.Temporary {...props} arcOut outcome={outcome} />;
  if (d?.animated) return <AiEdge.Animated {...props} outcome={outcome} />;
  return <AiEdge.Temporary {...props} outcome={outcome} />;
}

type FlowEdgeRenderProps = Parameters<typeof AiEdge.Animated>[0] & {
  data?: {
    animated?: boolean;
    isBackEdge?: boolean;
    isSkipEdge?: boolean;
    label?: string;
    outcome?: "success" | "fail";
    dim?: boolean;
  };
};

const nodeTypes = { [NODE_TYPE]: SwarmNode };
const edgeTypes = { [EDGE_TYPE]: SwarmEdge };

// ── Detail + Graph → React-Flow shape ────────────────────────────────────

interface SwarmNodeData extends Record<string, unknown> {
  nodeId: string;
  /** DOT `label` attr, with id fallback — used for the primary label
   *  in the header only when it differs from the id. Preserved for
   *  tests / inspector callers that want the display name. */
  label: string;
  /** DOT `label` attr as authored (or undefined when unset). Distinct
   *  from `label`: this one stays undefined when the user didn't set a
   *  label, so the header can suppress a title that'd just duplicate
   *  the id. */
  customLabel: string | undefined;
  /** Semantic handler type (`codergen`, `loop`, `conditional`, …). */
  handler: string;
  /** Whether this node carries `goal_gate=true`. Drives the green
   *  left-edge strip so operators can spot validation gates even when
   *  the handler is plain `codergen`. */
  goalGate: boolean;
  /** DOT model attribute, when set. */
  model: string | undefined;
  state: NodeState["state"] | "waiting" | null;
  lastEventSeq: number;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  active: boolean;
  selected: boolean;
  /** `true` when the executor hasn't reached this node — either "not yet"
   *  on a live run or "never will" on a terminal run. Rendered at reduced
   *  opacity so the executed path visually dominates. Always `false` in
   *  workflow-detail mode (no run, everything dims-equally would be noise). */
  dim: boolean;
  orientation: LayoutOrientation;
}

export interface ToFlowGraphOptions {
  activeNodeId?: string | null;
  selectedNodeId?: string | null;
  orientation?: LayoutOrientation;
  hitlNodeId?: string | null;
}

/**
 * Build `FlowNode[]` + `FlowEdge[]` from a parsed `Graph` and (optionally)
 * a `RunDetail`. Exported as a pure function so tests can exercise
 * the transform without mounting React.
 *
 * When `detail` is null the transform runs in workflow-detail mode:
 * every node renders with `state = null` and edges are non-animated.
 *
 * **Back-edge detection.** Edges whose target sits at an earlier depth
 * than their source are marked `isBackEdge` so the edge renderer picks
 * the Loop variant (dashed warn-colored arc) and routes them through
 * side handles on each node.
 *
 * Note: implicit start/exit markers stay visible. They carry meaning —
 * branches like `verify -> done [condition="outcome=fail"]` rely on
 * `done` being in the graph so the labeled terminal edge exists.
 */
export function toFlowGraph(
  detail: RunDetail | null,
  graph: Graph,
  opts: ToFlowGraphOptions = {},
): { flowNodes: FlowNode[]; flowEdges: FlowEdge[] } {
  const { activeNodeId = null, selectedNodeId = null, orientation = "TB", hitlNodeId = null } = opts;
  const stateById = new Map(detail?.nodes.map((n) => [n.nodeId, n]) ?? []);
  // `selectedEdges` is an ordered log of every (from,to) pair the executor
  // traversed. A Set lookup is enough because multiple traversals of the
  // same pair all mean "taken"; iteration count isn't surfaced visually yet.
  const takenEdges = new Set(detail?.selectedEdges.map((e) => edgeKey(e.from, e.to)) ?? []);
  // A node is "reached" if it received a `fact.node_*` event OR if some
  // selected edge points at it. Terminal nodes (Msquare) never emit their
  // own node_started/node_completed — the executor goes straight to
  // run_halted/run_completed — so without the edge fallback they'd render
  // as never-reached even when the run actually terminated on them.
  const reached = new Set<string>(stateById.keys());
  for (const e of detail?.selectedEdges ?? []) reached.add(e.to);
  const incoming = new Set(graph.edges.map((e) => e.to));
  const outgoing = new Set(graph.edges.map((e) => e.from));
  // "dim" applies only when a run exists — in workflow-detail mode
  // (no `detail`) every node/edge should render at full opacity because
  // the whole thing is a static topology inspection.
  const hasRun = detail != null;

  // Union DOT topology with detail.nodes so runs whose event stream
  // knows about a node not in the (stale) DOT still render it.
  const ids = new Set<string>();
  for (const id of Object.keys(graph.nodes)) ids.add(id);
  for (const n of detail?.nodes ?? []) ids.add(n.nodeId);

  const layoutInput = {
    nodes: [...ids].map((id) => ({ id })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
  };
  // Single DFS pass — shared with layoutDag's classifier via
  // `classifyGraph`. Back-edges drive edge styling; depths drive both
  // layout position and skip-edge detection.
  const { backEdgeKeys, depthOf } = classifyGraph(layoutInput);
  const positions = new Map(layoutDag(layoutInput, { orientation }).map((p) => [p.id, p.position]));

  const flowNodes: FlowNode[] = [...ids].map((id) => {
    const stateEntry = stateById.get(id);
    const topo: GraphNode | undefined = graph.nodes[id];
    const rawState: SwarmNodeData["state"] = stateEntry ? stateEntry.state : detail ? "pending" : null;
    // When the run is paused at a HITL gate, show that node as "waiting"
    // so operators can distinguish it from an actively-running node.
    const resolvedState: SwarmNodeData["state"] = hitlNodeId === id && rawState === "running" ? "waiting" : rawState;
    const data: SwarmNodeData = {
      nodeId: id,
      label: topo?.attrs.label ?? id,
      customLabel: topo?.attrs.label,
      handler: topo ? handlerOf(topo) : "unknown",
      goalGate: Boolean(topo?.attrs.goal_gate),
      model: topo?.attrs.llm_model,
      state: resolvedState,
      lastEventSeq: stateEntry?.lastEventSeq ?? 0,
      hasIncoming: incoming.has(id),
      hasOutgoing: outgoing.has(id),
      active: activeNodeId === id,
      selected: selectedNodeId === id,
      // Unreached nodes during a run fade. Workflow-detail mode leaves
      // everything at full opacity.
      dim: hasRun && !reached.has(id),
      orientation,
    };
    return {
      id,
      type: NODE_TYPE,
      data,
      position: positions.get(id) ?? { x: 0, y: 0 },
    };
  });

  const flowEdges: FlowEdge[] = graph.edges.map((e, i) => {
    const sd = depthOf.get(e.from);
    const td = depthOf.get(e.to);
    const isBackEdge = backEdgeKeys.has(edgeKey(e.from, e.to));
    // Skip-edge: forward edge that jumps past one or more intermediate
    // layers (e.g. `verify -> done` when update_docs/commit/merge sit
    // between them). Routing these through the side handles keeps their
    // path — and their edge label — clear of the nodes in between.
    const isSkipEdge = !isBackEdge && sd !== undefined && td !== undefined && td - sd > 1;
    const useSideHandles = isBackEdge || isSkipEdge;
    const label = edgeLabelOf(e);
    const outcome = outcomeOf(e);
    // Untaken edges fade. During a run, an edge is "taken" iff it appears
    // in `detail.selectedEdges`; outside a run (workflow-detail view)
    // everything renders at full opacity.
    const taken = takenEdges.has(edgeKey(e.from, e.to));
    const dim = hasRun && !taken;
    // Outcome wins over the generic skip/back marker color, so a failure
    // path renders red regardless of whether it's a skip-edge or not.
    const marker =
      outcome === "success"
        ? MARKER_SUCCESS
        : outcome === "fail"
          ? MARKER_FAIL
          : isBackEdge
            ? MARKER_LOOP
            : taken && !isSkipEdge
              ? MARKER_ANIMATED
              : MARKER_DEFAULT;
    return {
      id: `${e.from}->${e.to}#${i}`,
      source: e.from,
      target: e.to,
      type: EDGE_TYPE,
      // `animated` drives the SwarmEdge variant: Animated (solid, accent)
      // for any taken forward edge — whether or not the run is still live.
      data: { animated: !isBackEdge && !isSkipEdge && taken, isBackEdge, isSkipEdge, label, outcome, dim },
      sourceHandle: useSideHandles ? LOOP_HANDLE_SOURCE : undefined,
      targetHandle: useSideHandles ? LOOP_HANDLE_TARGET : undefined,
      markerEnd: marker,
    };
  });

  return { flowNodes, flowEdges };
}

/** Surface DOT edge `condition` / `label` attrs as the edge's pill text.
 *  Prefer `condition` — that's where branching semantics live in Swarm
 *  DOT (`outcome=success`, `outcome=fail`, etc.). */
function edgeLabelOf(edge: GraphEdge): string | undefined {
  const cond = edge.attrs.condition;
  if (typeof cond === "string" && cond.trim().length > 0) return cond;
  const label = edge.attrs.label;
  if (typeof label === "string" && label.trim().length > 0) return label;
  return undefined;
}

/** Parse `condition`/`label` for a success/fail outcome marker so the
 *  edge renderer can tone the stroke + pill in the matching accent. */
function outcomeOf(edge: GraphEdge): "success" | "fail" | undefined {
  const src = [edge.attrs.condition, edge.attrs.label]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (/\boutcome\s*=\s*success\b/.test(src) || /\bsuccess\b/.test(src)) return "success";
  if (/\boutcome\s*=\s*fail\b/.test(src) || /\bfail(ure)?\b/.test(src)) return "fail";
  return undefined;
}
