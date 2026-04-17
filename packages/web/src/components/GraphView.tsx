// GraphView — renders a pipeline run's workflow graph using Vercel AI
// Elements (`Canvas`, `Node`, `Edge`, `Controls`) which wrap `@xyflow/react`.
//
// Data path:
//   - Topology comes from the DOT source recorded on `pipeline.started`
//     and parsed in-browser via `@swarm/core`'s `parseDotSource`. This is
//     the SAME parser the runtime uses — one source of truth, zero risk
//     of drift.
//   - Lifecycle state (pending / running / completed / failed / skipped /
//     retrying) comes from `PipelineDetail.nodes[]` keyed by nodeId. Nodes
//     that only appear in the DOT topology (not yet in node events) render
//     as "pending".
//   - There is NO `detail.edges` field — the server does not parse DOT.
//     If you see a PR trying to add one, reject it.
//
// Public prop contract (stable; Playwright + unit tests depend on it):
//   - `runId`        — id passed to `api.getPipeline(id)`.
//   - `api`          — ApiClient used to fetch detail. Required when
//                      `runId` is set and `detail` is not supplied.
//   - `detail`       — pre-fetched `PipelineDetail`. Optional shortcut
//                      for parents that already have the data.
//   - `onNodeClick`  — invoked with `nodeId` on click.
//   - `activeNodeId` — highlight target.
//   - `refetchKey`   — value change → re-fetch detail (SSE-driven).
//
// Node DOM contract: each rendered node carries `data-node-id="<id>"`
// so existing tests (and any future Playwright) can target them.

import { type Graph, parseDotSource } from "@swarm/core";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps as FlowNodeProps } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient, NodeState, PipelineDetail } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { layoutDag } from "../lib/graph-layout.ts";
import { Canvas } from "./ai-elements/canvas.tsx";
import { Controls } from "./ai-elements/controls.tsx";
import { Edge as AiEdge } from "./ai-elements/edge.tsx";
import { Node as AiNode, NodeContent, NodeDescription, NodeHeader, NodeTitle } from "./ai-elements/node.tsx";
import { EmptyState } from "./ui/empty-state.tsx";

export interface GraphViewProps {
  /** When provided, we fetch `/pipelines/:runId` on mount. */
  runId?: string;
  /** API client used to fetch the detail when `runId` is set. */
  api?: ApiClient;
  /**
   * Pre-fetched detail. Takes precedence over `runId` — use this when
   * the parent is already loading the detail (e.g. PipelineDetail page).
   */
  detail?: PipelineDetail;
  /** Click → fires with the `data-node-id`. */
  onNodeClick?: (nodeId: string) => void;
  /** Highlight target. */
  activeNodeId?: string | null;
  /**
   * When this value changes, we re-fetch the detail (if `runId` is set
   * and `detail` was not supplied). Consumers pass e.g. `events.length`
   * from `useSSE` so the graph stays in sync with live updates.
   */
  refetchKey?: number | string;
}

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; detail: PipelineDetail }
  | { kind: "empty"; reason: string };

/** Custom React-Flow node type key — registered in `nodeTypes` below. */
const NODE_TYPE = "swarmNode";
/** Custom React-Flow edge type key — registered in `edgeTypes` below. */
const EDGE_TYPE = "swarmEdge";

export function GraphView(props: GraphViewProps): JSX.Element {
  const { runId, api, detail, onNodeClick, activeNodeId, refetchKey } = props;
  const [fetchState, setFetchState] = useState<FetchState>(() => {
    if (detail) return { kind: "ready", detail };
    if (runId && api) return { kind: "loading" };
    return { kind: "idle" };
  });

  // External `detail` prop wins — sync into state so re-renders track it.
  useEffect(() => {
    if (detail) setFetchState({ kind: "ready", detail });
  }, [detail]);

  // `refetchKey` is a deliberate trigger — bumping it re-runs the effect
  // even though the value itself is unused inside the body. The directive
  // below MUST remain a single line for Biome to attach it to the hook.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchKey is an intentional re-run trigger; its value is not read in the body.
  useEffect(() => {
    if (detail || !runId || !api) return;
    let cancelled = false;
    setFetchState({ kind: "loading" });
    api
      .getPipeline(runId)
      .then((d) => {
        if (!cancelled) setFetchState({ kind: "ready", detail: d });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[GraphView] failed to load detail for", runId, "—", message);
        setFetchState({ kind: "empty", reason: message });
      });
    return () => {
      cancelled = true;
    };
  }, [api, runId, detail, refetchKey]);

  // Parse DOT once per source change. Returning null means "no graph"
  // (older runs, partial starts) — the render path shows an empty state.
  const readyDetail = fetchState.kind === "ready" ? fetchState.detail : null;
  const graph: Graph | null = useMemo(() => {
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
  }, [readyDetail?.workflowSource, readyDetail?.runId]);

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!readyDetail || !graph) return { flowNodes: [], flowEdges: [] };
    return toFlowGraph(readyDetail, graph, activeNodeId ?? null);
  }, [readyDetail, graph, activeNodeId]);

  const handleNodeClick = useCallback(
    (_e: unknown, node: FlowNode) => {
      onNodeClick?.(node.id);
    },
    [onNodeClick],
  );

  if (fetchState.kind === "loading") {
    return (
      <div data-testid="graphview-loading" className="flex min-h-[320px] items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading graph…</p>
      </div>
    );
  }

  if (fetchState.kind === "idle") {
    return (
      <EmptyState
        data-testid="graphview-empty"
        title="No graph to display"
        description="Pass a runId + api or a detail prop to render."
      />
    );
  }

  if (fetchState.kind === "empty") {
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
      // React Flow needs an explicit height — the canvas fills its parent.
      className="h-[480px] w-full rounded-md border bg-sidebar"
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
  return (
    <AiNode
      handles={{ target: d.hasIncoming, source: d.hasOutgoing }}
      data-node-id={d.nodeId}
      data-state={d.state}
      className={cn("w-56", d.active && "ring-2 ring-primary")}
    >
      <NodeHeader className="gap-1 p-2!">
        <NodeTitle className="text-xs font-medium" title={d.label ?? d.nodeId}>
          {d.label ?? d.nodeId}
        </NodeTitle>
        <NodeDescription className="text-[10px]">
          <StateBadge state={d.state} />
        </NodeDescription>
      </NodeHeader>
      <NodeContent className="p-2 text-[10px] text-muted-foreground">
        <span className="font-mono">{d.nodeId}</span>
        {d.lastEventSeq > 0 ? <span className="ml-2">· seq {d.lastEventSeq}</span> : null}
      </NodeContent>
    </AiNode>
  );
}

function StateBadge({ state }: { state: NodeState["state"] }): JSX.Element {
  const tone =
    state === "running"
      ? "bg-blue-100 text-blue-800 border-blue-300"
      : state === "completed"
        ? "bg-emerald-100 text-emerald-800 border-emerald-300"
        : state === "failed"
          ? "bg-rose-100 text-rose-800 border-rose-300"
          : state === "retrying"
            ? "bg-amber-100 text-amber-800 border-amber-300"
            : state === "skipped"
              ? "bg-slate-200 text-slate-700 border-slate-300"
              : "bg-slate-100 text-slate-700 border-slate-300";
  return (
    <span className={cn("inline-block rounded-full border px-1.5 py-0 text-[10px] font-medium", tone)}>{state}</span>
  );
}

/**
 * Edge renderer: animated bezier for live/running runs, static dashed
 * "temporary" for completed/failed terminal runs. Both are AI Elements
 * primitives from `./ai-elements/edge.tsx`.
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
  label: string | undefined;
  state: NodeState["state"];
  lastEventSeq: number;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  active: boolean;
}

/**
 * Build `FlowNode[]` + `FlowEdge[]` from a `PipelineDetail` (lifecycle
 * state) and a parsed `Graph` (topology). Exported as a pure function so
 * tests can exercise the transform without mounting React.
 *
 * `detail.nodes` and `graph.nodes` are unioned by nodeId:
 *   - topology nodes (in `graph.nodes`) contribute label + handles,
 *   - lifecycle nodes (in `detail.nodes`) contribute state + seq,
 *   - nodes present only in `graph.nodes` get state="pending".
 *   - nodes present only in `detail.nodes` (rare: DOT and events out of
 *     sync) still render, just without an incoming/outgoing handle.
 */
export function toFlowGraph(
  detail: PipelineDetail,
  graph: Graph,
  activeNodeId: string | null,
): { flowNodes: FlowNode[]; flowEdges: FlowEdge[] } {
  const stateById = new Map(detail.nodes.map((n) => [n.nodeId, n]));
  const incoming = new Set(graph.edges.map((e) => e.to));
  const outgoing = new Set(graph.edges.map((e) => e.from));
  const isRunning = detail.status === "running";

  const ids = new Set<string>();
  for (const id of Object.keys(graph.nodes)) ids.add(id);
  for (const n of detail.nodes) ids.add(n.nodeId);

  const positions = new Map(
    layoutDag(
      {
        nodes: [...ids].map((id) => ({ id })),
        edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
      },
      { colWidth: 240, rowHeight: 110 },
    ).map((p) => [p.id, p.position]),
  );

  const flowNodes: FlowNode[] = [...ids].map((id) => {
    const state = stateById.get(id);
    const topo = graph.nodes[id];
    const data: SwarmNodeData = {
      nodeId: id,
      label: topo?.attrs?.label,
      state: state?.state ?? "pending",
      lastEventSeq: state?.lastEventSeq ?? 0,
      hasIncoming: incoming.has(id),
      hasOutgoing: outgoing.has(id),
      active: activeNodeId === id,
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
    data: { animated: isRunning },
  }));

  return { flowNodes, flowEdges };
}
