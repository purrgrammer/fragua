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
//      to inspect a `.yaml` file without needing a run.
//
// Data path notes:
//   - Topology is ALWAYS parsed from the workflow source via `@swarm/core`'s
//     `parseWorkflow` — the same parser the runtime uses. One source
//     of truth, zero risk of drift.
//   - There is NO `detail.edges` field on the server — topology lives
//     in the workflow source and is parsed client-side. Reject any PR that
//     tries to add one.
//   - Flow is top-to-bottom by default (`orientation="TB"`). Callers
//     can ask for `"LR"` when they need the horizontal strip.
//
// Node DOM contract: each rendered node carries `data-node-id="<id>"`
// so existing tests (and any future Playwright) can target them.

import {
  type Graph,
  type Edge as GraphEdge,
  type Node as GraphNode,
  handlerOf,
  maxGoalGateRetries,
  parseWorkflow,
  resolveRetargetChain,
} from "@swarm/core";
import { useQuery } from "@tanstack/react-query";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps as FlowNodeProps } from "@xyflow/react";
import { Handle, MarkerType, Position } from "@xyflow/react";
import { useCallback, useMemo } from "react";
import type { NodeState, RunDetail } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { classifyGraph, edgeKey, type LayoutOrientation, layoutDag } from "../lib/graph-layout.ts";
import { humanizeRouteName } from "../lib/humanize.ts";
import { canRetry as canRetryHandler, showsLlm } from "../lib/node-metadata.ts";
import { queries } from "../lib/queries.ts";
import { Canvas } from "./ai-elements/canvas.tsx";
import { Controls } from "./ai-elements/controls.tsx";
import { Edge as AiEdge } from "./ai-elements/edge.tsx";
import { ModelSelectorLogo } from "./ai-elements/model-selector.tsx";
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
  /** Every nodeId currently in `state === "running"` — superset of
   * `activeNodeId`. Parallel branches stay running while their parent
   * component is also running, and both should glow. When unset, falls
   * back to the singular `activeNodeId`. */
  activeNodeIds?: ReadonlySet<string>;
}

const NODE_TYPE = "swarmNode";
const EDGE_TYPE = "swarmEdge";

// Arrowhead used on every edge so flow direction is unambiguous.
// Theme tokens via CSS vars — modern browsers resolve var() in SVG
// presentation attributes, so markers follow light/dark mode.
const arrow = (color: string) => ({ type: MarkerType.ArrowClosed, width: 14, height: 14, color }) as const;
// Slightly lifted from --sw-border so the arrowhead stays visible on
// the default forward edge in dark mode (border tone disappears against
// --sw-bg). Taken / outcome / retry edges keep their semantic accents.
const MARKER_DEFAULT = arrow("var(--sw-muted)");
// Retry / loop / retarget edges share a neutral arrow tone. They're
// structural backflow — the run intentionally re-traverses upstream
// work — and shouldn't read as "negative" the way `outcome=fail`
// forward edges do. `--sw-accent-idle` is the project's neutral
// accent (gray); back-edges, self-loops, loop_restart, and synthetic
// goal-gate retargets all share it.
const MARKER_RETRY = arrow("var(--sw-accent-idle)");
const MARKER_ANIMATED = arrow("var(--sw-accent-thinking)");
const MARKER_FAIL = arrow("var(--sw-accent-error)");

// Handle IDs for back-edge / skip-edge routing. These edges enter/exit
// the right side of the node (TB orientation) or the bottom (LR) so
// their arc sits outside the main forward-flow column.
const LOOP_HANDLE_SOURCE = "loop-source";
const LOOP_HANDLE_TARGET = "loop-target";
// Synthetic goal-gate retarget edges route through the OPPOSITE side
// from regular loops — left in TB, top in LR — so the two retry channels
// read as separate visual lanes. Operators can tell at a glance whether
// a backward arc came from a written `verify -> verify [outcome=fail]`
// (right side, real edge) or from the §3.4 chain on a goal_gate
// (left side, synthetic).
const RETARGET_HANDLE_SOURCE = "retarget-source";
const RETARGET_HANDLE_TARGET = "retarget-target";

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
    activeNodeIds,
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
      return parseWorkflow(readyDetail.workflowSource);
    } catch (err) {
      console.warn(
        "[GraphView] failed to parse workflow source for",
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
        : readyDetail?.runStatus === "paused_human"
          ? (readyDetail.hitlNodeId ?? null)
          : null;
    return toFlowGraph(readyDetail, graph, {
      activeNodeId: activeNodeId ?? null,
      selectedNodeId: selectedNodeId ?? null,
      orientation,
      hitlNodeId: resolvedHitlNodeId,
      activeNodeIds: activeNodeIds ?? null,
    });
  }, [readyDetail, graph, activeNodeId, selectedNodeId, orientation, hitlNodeId, activeNodeIds]);

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
// archetype gets its own hue so a glance across the graph tells you the
// branching / HITL / tool / validation structure without reading labels:
//
//   goal_gate       → success  (green)       — "did we land it?"  (wins over handler)
//   human           → human    (steel blue)  — HITL / paused_human (incl. human routers)
//   router (routes=) → thinking (violet)      — control-flow decision point (llm fork)
//   tool            → loop     (teal)         — deterministic shell step (no LLM)
//   start / exit    → idle     (gray)         — lifecycle markers, dimmer presence
//   llm             → (no strip — neutral baseline; the LLM majority)
//
// Precedence: `goal_gate` wins (a validation gate is the more specific
// signal; mutually exclusive with `routes=` per E023). `human` wins over
// router so a human gate reads as HITL first — its routes are the button
// set, not the headline. An llm node with `routes=` is the only one that
// picks up the router hue.
function typeStripTone(handler: string, goalGate: boolean, isRouter: boolean): string | null {
  if (goalGate) return "bg-sw-accent-success";
  switch (handler) {
    case "human":
      return "bg-sw-accent-human";
    case "start":
    case "exit":
      return "bg-sw-accent-idle";
    case "tool":
      return "bg-sw-accent-loop";
    default:
      return isRouter ? "bg-sw-accent-thinking" : null;
  }
}

function SwarmNode({ data }: FlowNodeProps): JSX.Element {
  const d = data as SwarmNodeData;
  const handlerLabel = d.handler;
  // start / exit are lifecycle markers — no metadata, no LLM, no
  // retries — so they render as a compact header-only card. The
  // archetype stays legible via the eyebrow + idle-gray strip; the
  // body rows (id / model / retries / …) would only ever be empty.
  const isTerminal = handlerLabel === "start" || handlerLabel === "exit";
  const stripTone = typeStripTone(handlerLabel, d.goalGate, d.routeCount !== undefined);
  // Extra handles carry back-edges ("loop" returns) so they route around
  // the forward-flow column. In TB flow the arc lives on the right; in
  // LR, on the bottom. xyflow allows multiple handles per node as long
  // as their ids differ.
  const loopPos = d.orientation === "TB" ? Position.Right : Position.Bottom;
  // Synthetic goal-gate retarget arcs ride on the opposite side from
  // regular loops — left in TB, top in LR.
  const retargetPos = d.orientation === "TB" ? Position.Left : Position.Top;
  // Surface the the `label` attr in the header only when it carries meaning
  // beyond the id — otherwise the id (shown in the body) would appear
  // twice. Empty title ⇒ header reduces to handler + state dot.
  // For terminals, the id (`start` / `done`) IS the name — render it
  // as the title even when it duplicates the nodeId, so the card has
  // something to anchor on. For everything else, suppress titles that
  // just echo the id.
  const headerTitle: string | undefined = isTerminal ? (d.customLabel ?? d.nodeId) : d.customLabel;
  const hasHeaderTitle = isTerminal
    ? (headerTitle ?? "").length > 0
    : typeof d.customLabel === "string" && d.customLabel.length > 0 && d.customLabel !== d.nodeId;
  return (
    <AiNode
      handles={{ target: d.hasIncoming, source: d.hasOutgoing, orientation: d.orientation }}
      data-node-id={d.nodeId}
      data-state={d.state}
      data-handler={handlerLabel}
      data-compact={isTerminal ? "true" : undefined}
      data-dim={d.dim ? "true" : undefined}
      className={cn(
        // Unified width across archetypes — terminals used to render at
        // w-44, which broke the column gridline against w-60 regular
        // nodes. The compact form (header-only body, no metadata rows)
        // is preserved via `data-compact` + the `isTerminal ? null` body
        // branch below; only the bounding box widens.
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
      {/* Retarget handles — synthetic goal-gate retarget edges arc on the
          opposite side from regular loops (left in TB, top in LR), so the
          two retry channels read as separate visual lanes. xyflow drops
          edges whose handle ids don't exist on the node, so these MUST
          stay mounted. */}
      <Handle id={RETARGET_HANDLE_TARGET} position={retargetPos} type="target" style={{ opacity: 0 }} />
      <Handle id={RETARGET_HANDLE_SOURCE} position={retargetPos} type="source" style={{ opacity: 0 }} />
      <NodeHeader className="gap-0.5 p-2!">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sw-xs uppercase tracking-[0.06em] text-sw-muted" title={handlerLabel}>
            {handlerLabel}
          </span>
          {d.state && <StateDot state={d.state} />}
        </div>
        {hasHeaderTitle ? (
          <NodeTitle className="truncate text-sw-sm font-medium text-sw-text" title={headerTitle}>
            {headerTitle}
          </NodeTitle>
        ) : null}
      </NodeHeader>
      {isTerminal ? null : (
        <NodeContent className="flex flex-col gap-0.5 p-2 text-sw-xs text-sw-muted">
          <span className="truncate" title={d.nodeId}>
            <span className="uppercase tracking-[0.06em]">id</span> <code className="text-sw-text">{d.nodeId}</code>
          </span>
          {d.model ? (
            <span className="flex items-center gap-1" title={d.provider ? `${d.provider} · ${d.model}` : d.model}>
              <span className="uppercase tracking-[0.06em]">model</span>
              {d.provider ? <ModelSelectorLogo className="shrink-0" provider={d.provider} /> : null}
              <code className="truncate text-sw-text">{d.model}</code>
            </span>
          ) : null}
          {d.reasoningEffort ? (
            <span className="truncate" title={`reasoning_effort=${d.reasoningEffort}`}>
              <span className="uppercase tracking-[0.06em]">effort</span>{" "}
              <code className="text-sw-text">{d.reasoningEffort}</code>
            </span>
          ) : null}
          {/* thread_id — flags shared-session nodes (e.g. cluster_dev). */}
          {d.threadId ? (
            <span className="truncate" title={`thread_id=${d.threadId}`}>
              <span className="uppercase tracking-[0.06em]">thread</span>{" "}
              <code className="text-sw-text">{d.threadId}</code>
            </span>
          ) : null}
          {/* Tool nodes — surface the shell command directly. */}
          {d.toolCommand ? (
            <span className="truncate" title={d.toolCommand}>
              <span className="uppercase tracking-[0.06em]">cmd</span>{" "}
              <code className="text-sw-text">{d.toolCommand}</code>
            </span>
          ) : null}
          {/* goal_gate retarget — names where REJECT loops back to. */}
          {d.retryTarget ? (
            <span className="truncate" title={`retry_target=${d.retryTarget}`}>
              <span className="uppercase tracking-[0.06em]">retry</span>{" "}
              <code className="text-sw-text">{d.retryTarget}</code>
            </span>
          ) : null}
          {/* Handler-level retry cap. Only render when explicitly set; the
            implicit cascade (graph.default_max_retries → 0) isn't worth
            a line of chrome on every node. */}
          {d.maxRetries !== undefined && d.maxRetries > 0 ? (
            <span className="truncate" title={`max_retries=${d.maxRetries}`}>
              <span className="uppercase tracking-[0.06em]">retries</span>{" "}
              <code className="text-sw-text">{d.maxRetries}</code>
            </span>
          ) : null}
          {/* Routing-node badge — present when the node declares `routes=`.
            Box shape is unchanged; this chip is the only differentiator. */}
          {d.routeCount !== undefined ? (
            <span className="truncate" title={`routes=${d.routeCount}`} data-testid="node-route-count">
              <span className="uppercase tracking-[0.06em]">routes</span>{" "}
              <code className="rounded-sw-default border border-sw-border px-1 text-sw-text">{d.routeCount}</code>
            </span>
          ) : null}
        </NodeContent>
      )}
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
  if (d?.isBackEdge) {
    // Synthetic goal-gate retargets arc on the LEFT; real back-edges /
    // self-loops / loop_restart arc on the right. Two channels, no
    // visual collision.
    const arcSide = d?.isRetargetEdge ? "left" : "right";
    return <AiEdge.Loop {...props} outcome={outcome} arcSide={arcSide} />;
  }
  if (d?.isSkipEdge || d?.isParallelArc)
    return <AiEdge.Temporary {...props} arcOut arcSide={d?.arcSide ?? "right"} outcome={outcome} />;
  if (d?.animated) return <AiEdge.Animated {...props} outcome={outcome} />;
  return <AiEdge.Temporary {...props} outcome={outcome} />;
}

type FlowEdgeRenderProps = Parameters<typeof AiEdge.Animated>[0] & {
  data?: {
    animated?: boolean;
    isBackEdge?: boolean;
    isSkipEdge?: boolean;
    /** Non-primary member of a same-target group (`parallelIndex > 0`).
     *  Routed through the side handles + a wide arc so it doesn't
     *  draw on top of the straight primary edge — e.g. a `fail` edge and
     *  a `success` edge both landing on `exit`. */
    isParallelArc?: boolean;
    /** Side a skip / parallel arc bulges toward — `"left"` when the source
     *  node sits left of the target so the long edge stays on its own side.
     *  Left arcs mount on the retarget (left) handles. Default `"right"`. */
    arcSide?: "left" | "right";
    label?: string;
    outcome?: "success" | "fail";
    dim?: boolean;
    /** `loop_restart=true` — fresh-run restart edge (attractor §2.7).
     *  Routes through the right-side loop handles + carries a
     *  ` · loop_restart` suffix on its label. */
    loopRestart?: boolean;
    /** Synthetic edge from a `goal_gate=true` node to its §3.4 retarget.
     *  Not present in `graph.edges` — added by `toFlowGraph`. Routes
     *  through the LEFT-side retarget handles (opposite the back-edge
     *  side) so the two retry channels read as separate visual lanes. */
    isRetargetEdge?: boolean;
    /** Adjacent to a `kind=human` node (either source or target has
     *  `kind=human`). Renders in the idle-gray tone so operator-choice
     *  route buttons are legible at a glance — same neutral channel
     *  as retry edges. */
    isHumanEdge?: boolean;
    /** Position of this loop / retarget / skip edge among edges on the
     *  same arc side. Drives the per-edge bulge offset so multiple
     *  arcs don't overlap. Set by `toFlowGraph` for any edge routed
     *  through the loop or retarget handles, or any forward skip-edge
     *  that bulges out via the right-side arc. AiEdge.Loop and
     *  AiEdge.Temporary (in `arcOut` mode) both read it. */
    arcIndex?: number;
    /** Lateral-extent floor for the arc bulge (px). Equal to the max
     *  `|x|` (TB) or `|y|` (LR) of any node sitting strictly between
     *  source-depth and target-depth. The edge renderer pushes the
     *  cubic Bezier control x outside this floor (plus a margin) so
     *  the arc clears wide parallel fans. Set by `toFlowGraph` only
     *  when the arc actually has to clear at least one intermediate
     *  layer. */
    arcExtent?: number;
    /** Number of times the executor traversed this edge — aggregated
     *  from `detail.selectedEdges` by (from, to). Absent when zero, so
     *  the workflow-detail mode (no run) carries no count field. The
     *  badge surfaces this on edges that fired more than once — the
     *  load-bearing signal for back-edges, self-loops, and goal-gate
     *  retargets. */
    traversalCount?: number;
    /** This edge's slot when multiple edges share the same (from, to)
     *  pair — e.g. `triage -> plan [route=small]` + `triage -> plan
     *  [route=feature]`. Drives per-edge label offset so route labels
     *  don't stack on top of each other at the midpoint. Zero-indexed.
     *  Absent when the (from, to) pair has only one edge. */
    parallelIndex?: number;
    /** Total edges sharing this edge's (from, to) pair. Paired with
     *  `parallelIndex` so the renderer can centre the stack. */
    parallelCount?: number;
  };
};

const nodeTypes = { [NODE_TYPE]: SwarmNode };
const edgeTypes = { [EDGE_TYPE]: SwarmEdge };

// ── Detail + Graph → React-Flow shape ────────────────────────────────────

interface SwarmNodeData extends Record<string, unknown> {
  nodeId: string;
  /** the `label` attr attr, with id fallback — used for the primary label
   *  in the header only when it differs from the id. Preserved for
   *  tests / inspector callers that want the display name. */
  label: string;
  /** the `label` attr attr as authored (or undefined when unset). Distinct
   *  from `label`: this one stays undefined when the user didn't set a
   *  label, so the header can suppress a title that'd just duplicate
   *  the id. */
  customLabel: string | undefined;
  /** Semantic handler type (`llm`, `human`, `tool`, `start`, `exit`). */
  handler: string;
  /** Whether this node carries `goal_gate=true`. Drives the green
   *  left-edge strip so operators can spot validation gates even when
   *  the handler is plain `llm`. */
  goalGate: boolean;
  /** model attribute, when set. */
  model: string | undefined;
  /** `llm_provider` attribute. Surfaced alongside model so multi-provider
   *  workflows read at a glance which backend a node will hit. */
  provider: string | undefined;
  /** `reasoning_effort` (low | medium | high). Surfaced on the card so
   *  high-effort nodes are visible at a glance. */
  reasoningEffort: "low" | "medium" | "high" | undefined;
  /** Shared LLM session key (`thread_id`). Surfaced in the body so
   *  cluster_dev-style shared-session designs are visible at a glance. */
  threadId: string | undefined;
  /** Tool-node shell command (tool node). Truncated for display;
   *  full text lives in the `title` tooltip and the inspector. */
  toolCommand: string | undefined;
  /** §3.4 retarget for `goal_gate=true` nodes. Names where REJECT
   *  loops back to (or undefined when retargeting falls back to the
   *  graph-level chain). */
  retryTarget: string | undefined;
  /** Handler-level retry ceiling (`max_retries`). Surfaced in the
   *  body so loop-prone nodes are visible without opening the inspector. */
  maxRetries: number | undefined;
  /** Number of declared routes (`attrs.routes.length`). Non-zero only on
   *  routing nodes; renders as a small chip so operators can spot routing
   *  nodes without opening the inspector. */
  routeCount: number | undefined;
  state: NodeState["state"] | "waiting" | null;
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
  /** Set of every running nodeId. */
  activeNodeIds?: ReadonlySet<string> | null;
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
  const {
    activeNodeId = null,
    selectedNodeId = null,
    orientation = "TB",
    hitlNodeId = null,
    activeNodeIds = null,
  } = opts;
  // `detail.nodes` is sorted by `(nodeId, iteration)` ascending, so
  // overwriting by nodeId keeps the latest iteration's state — the
  // default "show me where this node ended up" behaviour for loops.
  const stateById = new Map(detail?.nodes.map((n) => [n.nodeId, n]) ?? []);
  // `selectedEdges` is an ordered log of every (from,to,iteration) triple
  // the executor traversed. We aggregate by (from,to) into a count so the
  // renderer can both (a) tell taken from un-taken (count > 0) and
  // (b) show how many times each edge fired — the load-bearing signal for
  // back-edges, self-loops, and goal-gate retargets that fire repeatedly.
  const traversalCounts = new Map<string, number>();
  for (const e of detail?.selectedEdges ?? []) {
    const k = edgeKey(e.from, e.to);
    traversalCounts.set(k, (traversalCounts.get(k) ?? 0) + 1);
  }
  // Per-gate visit count. Goal-gate retargets bypass `edge.selected`
  // (the executor sets `result.nextNode = action.target` without going
  // through the edge selector), so the synthetic retarget edge can't
  // read its fire count from `traversalCounts`.
  //
  // The earlier signal here was the gate's iteration field, on the
  // assumption that goal-gate retargets advance it. They don't: every
  // retargeted re-entry of the gate keeps `iteration=0`, so
  // `maxIteration` stayed stuck at 0 and the synthetic edge never
  // un-dimmed.
  //
  // Right signal: the gate's outgoing edge selections. Each visit of the
  // gate produces exactly one `edge.selected` whose `from === gateId`
  // (the chosen successor). N visits ⇒ N outgoing selections ⇒ N − 1
  // retargets fired. Holds for both the gate-eventually-approves and
  // cap-exhausted paths (the final visit in either case is the one not
  // followed by another retarget).
  const gateOutgoingCounts = new Map<string, number>();
  for (const e of detail?.selectedEdges ?? []) {
    gateOutgoingCounts.set(e.from, (gateOutgoingCounts.get(e.from) ?? 0) + 1);
  }
  // A node is "reached" if it received a `fact.node_*` event OR if some
  // selected edge points at it. Terminal nodes (exit) never emit their
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

  // Union workflow topology with detail.nodes so runs whose event stream
  // knows about a node not in the (stale) topology still render it.
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

  // Per-depth max lateral extent. Used to size arc bulges so that a
  // back-edge or skip-edge spanning a fanned-out layer pushes its bulge
  // OUTSIDE the rightmost (or leftmost) branch column instead of
  // cutting through it. In TB orientation "lateral" is x; in LR the
  // perpendicular axis is y — but arc-routed edges only use the right /
  // left handles in TB (bottom / top in LR), so for arc geometry we
  // care about the absolute value of the cross-axis coordinate.
  const lateral = (p: { x: number; y: number }): number => (orientation === "TB" ? Math.abs(p.x) : Math.abs(p.y));
  const lateralByDepth = new Map<number, number>();
  for (const [id, pos] of positions) {
    const d = depthOf.get(id) ?? 0;
    lateralByDepth.set(d, Math.max(lateralByDepth.get(d) ?? 0, lateral(pos)));
  }
  // For an arc-routed edge between depths sd and td (either direction),
  // return the max lateral extent of nodes sitting STRICTLY between
  // them — the layers the arc has to clear. Endpoints' own column is
  // ignored because the arc already starts/ends at those node edges.
  const arcExtentBetween = (sd: number | undefined, td: number | undefined): number => {
    if (sd === undefined || td === undefined) return 0;
    const lo = Math.min(sd, td);
    const hi = Math.max(sd, td);
    let max = 0;
    for (let d = lo + 1; d < hi; d += 1) {
      const v = lateralByDepth.get(d);
      if (v !== undefined && v > max) max = v;
    }
    return max;
  };

  const flowNodes: FlowNode[] = [...ids].map((id) => {
    const stateEntry = stateById.get(id);
    const topo: GraphNode | undefined = graph.nodes[id];
    const handler = topo ? handlerOf(topo) : "unknown";
    const rawState: SwarmNodeData["state"] = stateEntry ? stateEntry.state : detail ? "pending" : null;
    // When the run is paused at a HITL gate, show that node as "waiting"
    // so operators can distinguish it from an actively-running node.
    const resolvedState: SwarmNodeData["state"] = hitlNodeId === id && rawState === "running" ? "waiting" : rawState;
    const a = topo?.attrs;
    // Per-handler relevance predicates live in `lib/node-metadata.ts`
    // so the GraphView card and the NodeInspector drawer can't drift.
    const isLlmHandler = showsLlm(handler, a);
    const canRetry = canRetryHandler(handler);
    const data: SwarmNodeData = {
      nodeId: id,
      label: a?.label ?? id,
      customLabel: a?.label,
      handler,
      goalGate: Boolean(a?.goal_gate),
      model: isLlmHandler ? a?.llm_model : undefined,
      provider: isLlmHandler ? a?.llm_provider : undefined,
      reasoningEffort: isLlmHandler ? a?.reasoning_effort : undefined,
      threadId: isLlmHandler && typeof a?.thread_id === "string" ? a.thread_id : undefined,
      toolCommand: handler === "tool" && typeof a?.tool_command === "string" ? truncate(a.tool_command, 40) : undefined,
      // goal_gate (and therefore the §3.4 retarget chain) is only meaningful
      // on llm nodes today — `typeStripTone` documents the precedence.
      retryTarget:
        handler === "llm" && typeof a?.retry_target === "string" && a.retry_target !== "" ? a.retry_target : undefined,
      maxRetries: canRetry && typeof a?.max_retries === "number" ? a.max_retries : undefined,
      routeCount: Array.isArray(a?.routes) && a.routes.length > 0 ? a.routes.length : undefined,
      state: resolvedState,
      hasIncoming: incoming.has(id),
      hasOutgoing: outgoing.has(id),
      active: activeNodeIds ? activeNodeIds.has(id) : activeNodeId === id,
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

  // Per-side arc indices. Multiple arcs on the same side stack outward
  // by `arcIndex` so their bulges don't overlap.
  //
  // Assignment: rank by source depth descending so the *deepest* (bottom-
  // most in TB, rightmost in LR) edge gets arcIndex 0 — the tightest bulge
  // — and the topmost edge gets the largest. Top arcs span more vertical
  // distance and need more horizontal room to look natural; bottom arcs
  // are short hops that can stay close to the column.
  //
  // Tie-breaks on declaration order so the assignment is stable run-to-run.
  const rightArcEdgeIdxs: { idx: number; depth: number }[] = [];
  graph.edges.forEach((e, idx) => {
    const isBack = backEdgeKeys.has(edgeKey(e.from, e.to));
    const isSelfLoop = e.from === e.to;
    const sd = depthOf.get(e.from);
    const td = depthOf.get(e.to);
    const isSkip = !isBack && !isSelfLoop && sd !== undefined && td !== undefined && td - sd > 1;
    const loopRestart = e.attrs["loop_restart"] === true;
    if (isBack || isSelfLoop || loopRestart || isSkip) {
      rightArcEdgeIdxs.push({ idx, depth: sd ?? 0 });
    }
  });
  rightArcEdgeIdxs.sort((a, b) => b.depth - a.depth || a.idx - b.idx);
  const rightArcIndexByEdge = new Map<number, number>();
  rightArcEdgeIdxs.forEach((r, i) => {
    rightArcIndexByEdge.set(r.idx, i);
  });

  // Parallel-edge slots. Two `triage -> plan` edges (one per route) draw
  // identical paths; their labels would stack at the same midpoint. Group
  // by (from, to), assign each member an index + total so the renderer
  // can offset labels along the cross-axis.
  const parallelGroups = new Map<string, number[]>();
  graph.edges.forEach((e, idx) => {
    const k = edgeKey(e.from, e.to);
    const bucket = parallelGroups.get(k);
    if (bucket) bucket.push(idx);
    else parallelGroups.set(k, [idx]);
  });
  const parallelSlotByEdge = new Map<number, { index: number; count: number }>();
  for (const idxs of parallelGroups.values()) {
    if (idxs.length < 2) continue;
    idxs.forEach((edgeIdx, slot) => {
      parallelSlotByEdge.set(edgeIdx, { index: slot, count: idxs.length });
    });
  }

  const flowEdges: FlowEdge[] = graph.edges.map((e, i) => {
    const sd = depthOf.get(e.from);
    const td = depthOf.get(e.to);
    const isBackEdge = backEdgeKeys.has(edgeKey(e.from, e.to));
    const isSelfLoop = e.from === e.to;
    // Skip-edge: forward edge that jumps past one or more intermediate
    // layers (e.g. `verify -> done` when update_docs/commit/merge sit
    // between them). Routing these through the side handles keeps their
    // path — and their edge label — clear of the nodes in between.
    const isSkipEdge = !isBackEdge && !isSelfLoop && sd !== undefined && td !== undefined && td - sd > 1;
    const useSideHandles = isBackEdge || isSelfLoop || isSkipEdge;
    const baseLabel = edgeLabelOf(e);
    const declaredOutcome = outcomeOf(e);
    // `loop_restart=true` edges terminate the current run and re-launch
    // with a fresh log directory. Routed via the loop handles + loop
    // marker so direction reads as "cycle" not "data flow"; the label
    // surfaces the attribute name plainly.
    const loopRestart = e.attrs["loop_restart"] === true;
    // Non-primary member of a same-target group: arc it out to the side
    // so it doesn't overlap the straight primary edge (e.g. `fail` and
    // `success` both landing on `exit`, or a route fan into one node).
    // Skip / back / self / loop_restart edges already arc, so this only
    // catches plain forward parallels.
    const parallelSlot = parallelSlotByEdge.get(i);
    const parallelArc = parallelSlot !== undefined && parallelSlot.index > 0 && !useSideHandles && !loopRestart;
    // Conditional retry/loop edges (back-edges or self-loops) get a
    // ` · cap N` suffix when the target has a handler-level `max_retries`.
    // Forward edges with `outcome=fail` aren't loops, so a cap doesn't
    // apply — the suffix stays gated on the loop predicate.
    const targetMax = isBackEdge || isSelfLoop ? graph.nodes[e.to]?.attrs.max_retries : undefined;
    let label: string | undefined = baseLabel;
    if (typeof targetMax === "number" && targetMax > 0) {
      label = label !== undefined ? `${label} · cap ${targetMax}` : `cap ${targetMax}`;
    }
    if (loopRestart) {
      label = label !== undefined ? `${label} · loop_restart` : "loop_restart";
    }
    // Untaken edges fade. During a run, an edge is "taken" iff it appears
    // in `detail.selectedEdges`; outside a run (workflow-detail view)
    // everything renders at full opacity.
    const traversalCount = traversalCounts.get(edgeKey(e.from, e.to)) ?? 0;
    const taken = traversalCount > 0;
    const dim = hasRun && !taken;
    // In a run, an `outcome=fail` edge that never fired is just topology —
    // rendering it red would broadcast a failure that didn't happen.
    // Suppress the outcome accent when the run exists and the edge wasn't
    // taken; the workflow-detail view (no run) keeps it for topology reading.
    const outcome = hasRun && !taken ? undefined : declaredOutcome;
    // Multi-fire edges (back-edges that re-traverse on REJECT, self-loops
    // hitting max_retries, retargets that loop) get an `×N` count badge
    // folded into the label pill so operators can see at a glance how
    // many times each edge fired. Single traversals are the baseline and
    // don't add chrome.
    if (traversalCount > 1) {
      label = label !== undefined ? `${label} · ×${traversalCount}` : `×${traversalCount}`;
    }
    // Loop-channel check wins over outcome: a `verify -> verify
    // [outcome=fail]` self-loop is a *retry*, not a negative-outcome
    // forward edge — rendering it red would misrepresent the semantic.
    // Forward edges still pick up success/fail tones from outcome.
    const isLoopChannel = isBackEdge || isSelfLoop || loopRestart;
    // Right-side arc index — assigned above by the depth-aware ranking
    // pass, not a sequential counter. Topmost source → largest arcIndex
    // (widest bulge). Skip-edges share the lane with loop-channel edges.
    // Parallel arcs aren't in the skip/loop ranking map; stagger them by
    // their slot so 3+ edges into one target fan out instead of stacking.
    const arcIndex = parallelArc && parallelSlot ? parallelSlot.index - 1 : rightArcIndexByEdge.get(i);
    // Arc extent floor — measured against the nodes sitting between
    // source-depth and target-depth. The edge renderer uses this to
    // push the arc bulge past a wide fanned-out layer (otherwise the
    // curve cuts through the rightmost / leftmost branch column).
    const arcExtent = useSideHandles || loopRestart || parallelArc ? arcExtentBetween(sd, td) : 0;
    // Human-node edges (adjacent to a `kind=human` node) carry operator
    // route choices. Promote them to the neutral idle-gray tone — same
    // channel as retry edges — so they stand out without claiming an
    // outcome accent. The flag is true when *either* endpoint has kind=human.
    const sourceNode = graph.nodes[e.from];
    const targetNode = graph.nodes[e.to];
    const isHumanEdge =
      (sourceNode !== undefined && sourceNode.type === "human") ||
      (targetNode !== undefined && targetNode.type === "human");
    const marker = isLoopChannel
      ? MARKER_RETRY
      : outcome === "fail"
        ? MARKER_FAIL
        : taken && !isSkipEdge
          ? MARKER_ANIMATED
          : isHumanEdge
            ? MARKER_RETRY
            : MARKER_DEFAULT;
    // Skip / parallel arcs bulge to the side their source leans (left node →
    // left arc) so a left branch's long edge stays on its own side instead of
    // crossing the graph. Structural loops (back / self / loop_restart) keep
    // the right channel. A left arc mounts on the left (retarget) handles.
    const arcSide: "left" | "right" =
      (isSkipEdge || parallelArc) && (positions.get(e.from)?.x ?? 0) < (positions.get(e.to)?.x ?? 0) - 1
        ? "left"
        : "right";
    const leftArc = arcSide === "left";
    return {
      id: `${e.from}->${e.to}#${i}`,
      source: e.from,
      target: e.to,
      type: EDGE_TYPE,
      // `animated` drives the SwarmEdge variant: Animated (solid, accent)
      // for any taken forward edge — whether or not the run is still live.
      data: {
        animated: !isBackEdge && !isSelfLoop && !isSkipEdge && !loopRestart && !parallelArc && taken,
        isBackEdge: isBackEdge || isSelfLoop || loopRestart,
        isSkipEdge,
        isParallelArc: parallelArc,
        arcSide,
        label,
        outcome,
        dim,
        loopRestart,
        isHumanEdge,
        ...(traversalCount > 0 ? { traversalCount } : {}),
        ...(arcIndex !== undefined ? { arcIndex } : {}),
        ...(arcExtent > 0 ? { arcExtent } : {}),
        ...(parallelSlotByEdge.has(i)
          ? {
              parallelIndex: parallelSlotByEdge.get(i)?.index,
              parallelCount: parallelSlotByEdge.get(i)?.count,
            }
          : {}),
      },
      sourceHandle: leftArc
        ? RETARGET_HANDLE_SOURCE
        : useSideHandles || loopRestart || parallelArc
          ? LOOP_HANDLE_SOURCE
          : undefined,
      targetHandle: leftArc
        ? RETARGET_HANDLE_TARGET
        : useSideHandles || loopRestart || parallelArc
          ? LOOP_HANDLE_TARGET
          : undefined,
      markerEnd: marker,
    };
  });

  // Synthetic retarget edges. Each `goal_gate=true` node has an implicit
  // fall-back jump per attractor §3.4: gate.retry_target →
  // gate.fallback_retry_target → graph.retry_target →
  // graph.fallback_retry_target. The engine doesn't emit these as real
  // edges, but the relationship is load-bearing for understanding the
  // workflow, so we render them as neutral back-arcs with a
  // `retarget · cap N` label. `resolveRetargetChain` returns null when no
  // target resolves — those gates can only halt, which W007 already
  // warns about at validate-time.
  // Synthetic retargets — sort source-depth descending so the topmost
  // gate gets the widest left-side arc, mirroring the right-side rule.
  const goalGateCap = maxGoalGateRetries(graph.attrs);
  const retargetCandidates: { gateId: string; target: string; depth: number }[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.attrs.goal_gate !== true) continue;
    const target = resolveRetargetChain(graph, node.id);
    if (target === null || target === node.id) continue;
    retargetCandidates.push({ gateId: node.id, target, depth: depthOf.get(node.id) ?? 0 });
  }
  retargetCandidates.sort((a, b) => b.depth - a.depth || a.gateId.localeCompare(b.gateId));
  const synthEdges: FlowEdge[] = retargetCandidates.map((r, leftArcIndex) => {
    const targetDepth = depthOf.get(r.target);
    const synthExtent = arcExtentBetween(r.depth, targetDepth);
    // Retarget firings == (gate's outgoing edge selections) − 1. Each
    // visit of the gate produces exactly one outgoing `edge.selected`;
    // every visit but the last triggered a retarget. Zero when the
    // gate ran at most once; positive once any retarget actually fired,
    // which is what flips this edge from dim to highlighted.
    const gateVisits = gateOutgoingCounts.get(r.gateId) ?? 0;
    const retargetCount = gateVisits > 0 ? gateVisits - 1 : 0;
    const taken = retargetCount > 0;
    const baseLabel = `retarget · cap ${goalGateCap}`;
    const capLabel = retargetCount > 0 ? `${baseLabel} · ×${retargetCount}` : baseLabel;
    return {
      id: `__retarget__${r.gateId}->${r.target}`,
      source: r.gateId,
      target: r.target,
      type: EDGE_TYPE,
      data: {
        animated: false,
        isBackEdge: true,
        isSkipEdge: false,
        label: capLabel,
        outcome: undefined,
        dim: hasRun && !taken,
        loopRestart: false,
        isRetargetEdge: true,
        arcIndex: leftArcIndex,
        ...(retargetCount > 0 ? { traversalCount: retargetCount } : {}),
        ...(synthExtent > 0 ? { arcExtent: synthExtent } : {}),
      },
      // Left-side handles so synthetic retargets visually separate from
      // real back-edges (which route through the right-side LOOP handles).
      sourceHandle: RETARGET_HANDLE_SOURCE,
      targetHandle: RETARGET_HANDLE_TARGET,
      markerEnd: MARKER_RETRY,
    };
  });

  return { flowNodes, flowEdges: [...flowEdges, ...synthEdges] };
}

/** Surface workflow edge attrs as the edge's pill text.
 *  Precedence: `attrs.label` first (authored display string); then
 *  `attrs.outcome` — but only `fail`, since success is the implicit
 *  default flow and earns no label; then `attrs.route` (humanized).
 *  `attrs.condition` is no longer read — the condition DSL is removed. */
function edgeLabelOf(edge: GraphEdge): string | undefined {
  const label = edge.attrs.label;
  if (typeof label === "string" && label.trim().length > 0) return label;
  if (edge.attrs.outcome === "fail") return "fail";
  const route = edge.attrs.route;
  if (typeof route === "string" && route.trim().length > 0) return humanizeRouteName(route);
  return undefined;
}

/** Derive the accented outcome. `success` is the implicit default and
 *  renders as a plain edge (route-color, no label); only `fail` earns
 *  the error accent so the eye is drawn to failure branches alone. */
function outcomeOf(edge: GraphEdge): "fail" | undefined {
  return edge.attrs.outcome === "fail" ? "fail" : undefined;
}

/** Compact-display helper for long values (tool commands, prompts, …).
 *  Keeps head + ellipsis so the start of the string remains readable. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
