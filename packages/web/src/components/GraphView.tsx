// GraphView — renders a swarm workflow graph using Vercel AI Elements
// (`Canvas`, `Node`, `Edge`, `Controls`) on top of `@xyflow/react`.
//
// Two call shapes:
//
//   1. Pipeline-live:  <GraphView runId=… />           (or detail=…)
//      Topology from `PipelineDetail.workflowSource`, lifecycle state
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

import { type Graph, type Node as GraphNode, handlerOf, parseDotSource } from "@swarm/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps as FlowNodeProps } from "@xyflow/react";
import { useCallback, useEffect, useMemo } from "react";
import type { NodeState, PipelineDetail } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { type LayoutOrientation, layoutDag } from "../lib/graph-layout.ts";
import { queries } from "../lib/queries.ts";
import { Canvas } from "./ai-elements/canvas.tsx";
import { Controls } from "./ai-elements/controls.tsx";
import { Edge as AiEdge } from "./ai-elements/edge.tsx";
import { Node as AiNode, NodeContent, NodeDescription, NodeHeader, NodeTitle } from "./ai-elements/node.tsx";
import { EmptyState } from "./ui/empty-state.tsx";

export interface GraphViewProps {
  /** When provided (and no `detail`/`graph`), we fetch `/pipelines/:runId`. */
  runId?: string;
  /**
   * Pre-fetched pipeline detail. Takes precedence over `runId` — used
   * when the parent is already loading the detail (e.g. PipelineDetail
   * page). Supplies workflow source AND live lifecycle state.
   */
  detail?: PipelineDetail;
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
  /**
   * When this value changes, invalidate the detail query so the graph
   * refetches. Parents pass e.g. `events.length` from SSE so the graph
   * stays in sync with live updates. Unused in workflow-detail mode.
   */
  refetchKey?: number | string;
}

const NODE_TYPE = "swarmNode";
const EDGE_TYPE = "swarmEdge";

export function GraphView(props: GraphViewProps): JSX.Element {
  const {
    runId,
    detail: detailProp,
    graph: graphProp,
    onNodeClick,
    activeNodeId,
    selectedNodeId,
    orientation = "TB",
    refetchKey,
  } = props;

  const qc = useQueryClient();
  const query = useQuery({
    ...queries.pipelines.detail(runId ?? ""),
    enabled: !!runId && !detailProp && !graphProp,
  });

  // `refetchKey` is a deliberate invalidation trigger for the live view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchKey is the trigger.
  useEffect(() => {
    if (runId && !detailProp && !graphProp) {
      void qc.invalidateQueries({ queryKey: queries.pipelines.detail(runId).queryKey });
    }
  }, [refetchKey]);

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
    return toFlowGraph(readyDetail, graph, {
      activeNodeId: activeNodeId ?? null,
      selectedNodeId: selectedNodeId ?? null,
      orientation,
    });
  }, [readyDetail, graph, activeNodeId, selectedNodeId, orientation]);

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

function SwarmNode({ data }: FlowNodeProps): JSX.Element {
  const d = data as SwarmNodeData;
  const handlerLabel = d.handler;
  return (
    <AiNode
      handles={{ target: d.hasIncoming, source: d.hasOutgoing, orientation: d.orientation }}
      data-node-id={d.nodeId}
      data-state={d.state}
      data-handler={handlerLabel}
      className={cn(
        "w-60 transition-colors duration-[var(--sw-duration-status)]",
        d.active && "ring-2 ring-sw-accent-thinking",
        d.selected && !d.active && "ring-2 ring-sw-accent-idle",
      )}
    >
      <NodeHeader className="gap-0.5 p-2!">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sw-xs uppercase tracking-[0.06em] text-sw-muted" title={handlerLabel}>
            {handlerLabel}
          </span>
          {d.state && <StateDot state={d.state} />}
        </div>
        <NodeTitle className="truncate text-sw-sm font-medium text-sw-text" title={d.label}>
          {d.label}
        </NodeTitle>
        {d.iterationLabel && <NodeDescription className="text-sw-xs text-sw-muted">{d.iterationLabel}</NodeDescription>}
      </NodeHeader>
      <NodeContent className="flex flex-col gap-0.5 p-2 text-sw-xs text-sw-muted">
        {d.model ? (
          <span className="truncate" title={d.model}>
            <span className="uppercase tracking-[0.06em]">model</span> <code className="text-sw-text">{d.model}</code>
          </span>
        ) : (
          <span className="truncate">
            <span className="uppercase tracking-[0.06em]">id</span> <code className="text-sw-text">{d.nodeId}</code>
          </span>
        )}
        {d.lastEventSeq > 0 ? <span>seq {d.lastEventSeq}</span> : null}
      </NodeContent>
    </AiNode>
  );
}

function StateDot({ state }: { state: NodeState["state"] }): JSX.Element {
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

function stateStyle(state: NodeState["state"]): { tone: string; pulse: boolean } {
  switch (state) {
    case "running":
      return { tone: "bg-sw-accent-thinking", pulse: true };
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
 * Edge renderer: animated bezier for live/running runs, static dashed
 * "temporary" for completed/failed terminal runs and static views.
 */
function SwarmEdge(props: FlowEdgeRenderProps): JSX.Element {
  return props.data?.animated ? <AiEdge.Animated {...props} /> : <AiEdge.Temporary {...props} />;
}

type FlowEdgeRenderProps = Parameters<typeof AiEdge.Animated>[0] & {
  data?: { animated?: boolean };
};

const nodeTypes = { [NODE_TYPE]: SwarmNode };
const edgeTypes = { [EDGE_TYPE]: SwarmEdge };

// ── Detail + Graph → React-Flow shape ────────────────────────────────────

interface SwarmNodeData extends Record<string, unknown> {
  nodeId: string;
  label: string;
  /** Semantic handler type (`codergen`, `loop`, `conditional`, …). */
  handler: string;
  /** DOT model attribute, when set. */
  model: string | undefined;
  /** Pre-rendered iteration badge text ("×3 iterations") for loop nodes. */
  iterationLabel: string | undefined;
  state: NodeState["state"] | null;
  lastEventSeq: number;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  active: boolean;
  selected: boolean;
  orientation: LayoutOrientation;
}

export interface ToFlowGraphOptions {
  activeNodeId?: string | null;
  selectedNodeId?: string | null;
  orientation?: LayoutOrientation;
}

/**
 * Build `FlowNode[]` + `FlowEdge[]` from a parsed `Graph` and (optionally)
 * a `PipelineDetail`. Exported as a pure function so tests can exercise
 * the transform without mounting React.
 *
 * When `detail` is null the transform runs in workflow-detail mode:
 * every node renders with `state = null` and edges are non-animated.
 */
export function toFlowGraph(
  detail: PipelineDetail | null,
  graph: Graph,
  opts: ToFlowGraphOptions = {},
): { flowNodes: FlowNode[]; flowEdges: FlowEdge[] } {
  const { activeNodeId = null, selectedNodeId = null, orientation = "TB" } = opts;
  const stateById = new Map(detail?.nodes.map((n) => [n.nodeId, n]) ?? []);
  const incoming = new Set(graph.edges.map((e) => e.to));
  const outgoing = new Set(graph.edges.map((e) => e.from));
  const isRunning = detail?.status === "running";

  const ids = new Set<string>();
  for (const id of Object.keys(graph.nodes)) ids.add(id);
  for (const n of detail?.nodes ?? []) ids.add(n.nodeId);

  const positions = new Map(
    layoutDag(
      {
        nodes: [...ids].map((id) => ({ id })),
        edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
      },
      { orientation },
    ).map((p) => [p.id, p.position]),
  );

  const flowNodes: FlowNode[] = [...ids].map((id) => {
    const stateEntry = stateById.get(id);
    const topo: GraphNode | undefined = graph.nodes[id];
    const data: SwarmNodeData = {
      nodeId: id,
      label: topo?.attrs.label ?? id,
      handler: topo ? handlerOf(topo) : "unknown",
      model: topo?.attrs.model,
      iterationLabel: iterationLabelFor(topo),
      state: stateEntry ? stateEntry.state : detail ? "pending" : null,
      lastEventSeq: stateEntry?.lastEventSeq ?? 0,
      hasIncoming: incoming.has(id),
      hasOutgoing: outgoing.has(id),
      active: activeNodeId === id,
      selected: selectedNodeId === id,
      orientation,
    };
    return {
      id,
      type: NODE_TYPE,
      data,
      position: positions.get(id) ?? { x: 0, y: 0 },
    };
  });

  const flowEdges: FlowEdge[] = graph.edges.map((e, i) => ({
    id: `${e.from}->${e.to}#${i}`,
    source: e.from,
    target: e.to,
    type: EDGE_TYPE,
    data: { animated: Boolean(isRunning) },
  }));

  return { flowNodes, flowEdges };
}

/** Loop nodes (trapezium) surface their iteration cap in the card so
 *  operators don't need to open the inspector to see "how many rounds
 *  can this run?". Returns `undefined` for non-loop nodes. */
function iterationLabelFor(topo: GraphNode | undefined): string | undefined {
  if (!topo || topo.shape !== "trapezium") return undefined;
  const max = topo.attrs.max_iterations;
  if (typeof max === "number" && max > 0) return `×${max} iterations`;
  return "loop";
}
