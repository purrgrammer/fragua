// Auto-dispatcher: lazily builds HandlerSpecs from a workflow's DOT source.
//
// Used as a DispatcherResolver fallback so new workflows added via HTTP
// after daemon start get their nodes registered on first dispatch. Each
// node's spec is derived from its shape / `type` attribute.
//
// Two-pass build: first pass creates specs for leaf kinds (codergen,
// tool, wait.human, etc.); second pass creates `parallel` specs whose
// `resolveChild` closures read from the specs map, and `fan_in` specs
// that point at their paired parallel node.

import type { Node, NodeAttrs } from "@swarm/core";
import { InvalidDurationError, parseDotSource, parseDurationMs } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import type { IEventStore } from "@swarm/store";
import type { DispatcherResolver } from "./dispatch.ts";

type HandlerContext = handler.HandlerContext;
type HandlerSpec = handler.HandlerSpec;

export interface AutoDispatcherOpts {
  store: IEventStore;
  /**
   * Optional factory that builds a real codergen handler for `box`-shape
   * nodes. When provided, the auto-dispatcher uses it instead of the
   * trivial noop transition so any box node that reaches the daemon is
   * executed via a real LLM backend. `nextNode` is passed as a legacy
   * fallback for factories that don't rely on the executor's edge
   * selector; factories are free to ignore it. `maxMs` is resolved from
   * the node's `timeout=`/`maxMs=` attrs (see `resolveMaxMs` below);
   * factories forward it into the HandlerSpec.
   */
  codergenFactory?: (node: Node, nextNode: string, maxMs: number | undefined) => HandlerSpec;
  /** Per-kind fallback `maxMs` when the DOT node declares neither
   * `timeout` nor `maxMs`. Keyed by handler kind (`codergen`, `tool`).
   * Absent kind → handler's own built-in default applies. */
  defaultMaxMs?: { codergen?: number; tool?: number };
}

/**
 * Resolve a handler's `maxMs` from a DOT node's attrs, falling back to
 * `fallbackMs` (per-kind config) and finally the handler's own default.
 * Precedence:
 *   1. `attrs.maxMs` — numeric literal in ms
 *   2. `attrs.timeout` — duration string ("30s", "5m", "2h", etc.)
 *   3. caller-supplied fallback (undefined → handler default applies)
 *
 * Malformed values reach this function only when the DOT was parsed
 * without enqueue-time validation (tests, direct-store inserts). We
 * surface the parse error as a thrown `InvalidDurationError` — callers
 * use `malformed*Spec` to return a clean halt fact instead of crashing
 * the dispatcher.
 */
export function resolveMaxMs(attrs: NodeAttrs, fallbackMs: number | undefined): number | undefined {
  if (typeof attrs.maxMs === "number") return parseDurationMs(attrs.maxMs);
  if (typeof attrs.timeout === "string") return parseDurationMs(attrs.timeout);
  return fallbackMs;
}

/**
 * Build a DispatcherResolver backed by the store. Parses each workflow
 * once on first use and caches the spec per (workflowSha, nodeId).
 */
export function autoDispatcherResolver(opts: AutoDispatcherOpts): DispatcherResolver {
  const perWorkflow = new Map<string, Map<string, HandlerSpec>>();

  return (workflowSha, nodeId) => {
    let specs = perWorkflow.get(workflowSha);
    if (specs == null) {
      const workflow = opts.store.getWorkflow(workflowSha);
      if (workflow == null) return null;
      specs = specsForGraph(workflow.dotSource, opts.codergenFactory, opts.defaultMaxMs);
      perWorkflow.set(workflowSha, specs);
    }
    return specs.get(nodeId) ?? null;
  };
}

function specsForGraph(
  dotSource: string,
  codergenFactory?: AutoDispatcherOpts["codergenFactory"],
  defaultMaxMs?: AutoDispatcherOpts["defaultMaxMs"],
): Map<string, HandlerSpec> {
  const graph = parseDotSource(dotSource);
  const outgoing = new Map<string, Array<{ to: string; label?: string }>>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    const edgeLabel = typeof edge.attrs.label === "string" ? edge.attrs.label : undefined;
    const entry: { to: string; label?: string } = { to: edge.to };
    if (edgeLabel !== undefined) entry.label = edgeLabel;
    list.push(entry);
    outgoing.set(edge.from, list);
  }
  const specs = new Map<string, HandlerSpec>();

  // Pass 1: leaf handler kinds.
  for (const node of Object.values(graph.nodes)) {
    const kind = handlerKindOf(node.attrs);
    if (kind === "parallel" || kind === "parallel.fan_in") continue;
    const edges = outgoing.get(node.id) ?? [];
    const first = edges[0]?.to ?? "__end__";
    let resolvedMaxMs: number | undefined;
    try {
      const fallback = kind === "codergen" ? defaultMaxMs?.codergen : kind === "tool" ? defaultMaxMs?.tool : undefined;
      resolvedMaxMs = resolveMaxMs(node.attrs, fallback);
    } catch (err) {
      if (err instanceof InvalidDurationError) {
        specs.set(node.id, malformedTimeoutSpec(node.id, err.message));
        continue;
      }
      throw err;
    }
    const useFactory = kind === "codergen" && codergenFactory != null;
    specs.set(
      node.id,
      useFactory ? codergenFactory(node, first, resolvedMaxMs) : specForNode(node.id, edges, node.attrs, resolvedMaxMs),
    );
  }

  // Pass 2: parallel + fan_in, which need cross-node references.
  for (const node of Object.values(graph.nodes)) {
    const kind = handlerKindOf(node.attrs);
    if (kind === "parallel") {
      const children = outgoing.get(node.id)?.map((e) => e.to) ?? [];
      const fanInId = typeof node.attrs.fan_in === "string" ? node.attrs.fan_in : "";
      if (fanInId.length === 0 || children.length === 0) {
        // Validator flags these at authoring; at runtime we halt with a
        // clear message rather than silently no-op into a bad state.
        specs.set(node.id, malformedParallelSpec(node.id));
        continue;
      }
      const joinPolicy = node.attrs.join_policy === "first_success" ? "first_success" : "wait_all";
      specs.set(
        node.id,
        handler.makeParallelHandler({
          children,
          fanInNode: fanInId,
          joinPolicy,
          resolveChild: (childId) => specs.get(childId) ?? null,
          buildChildContext: (childId, parentCtx) => buildBranchContext(childId, parentCtx),
        }),
      );
    } else if (kind === "parallel.fan_in") {
      // Find the parallel node whose fan_in attr points here.
      const parallelNodeId = findParallelParent(graph.nodes, node.id);
      if (parallelNodeId == null) {
        specs.set(node.id, malformedFanInSpec(node.id));
        continue;
      }
      specs.set(node.id, handler.makeFanInHandler({ parallelNodeId }));
    }
  }

  return specs;
}

function malformedTimeoutSpec(nodeId: string, message: string): HandlerSpec {
  return {
    kind: "codergen",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `node "${nodeId}": ${message}`,
    }),
  };
}

/**
 * Child HandlerContext used when a parallel branch is dispatched. The
 * child sees the parent's shared resources (store-backed artifacts /
 * messages / tools / llm / externalCall) but with its own nodeId, a
 * deep-cloned routing snapshot, and iteration reset to 0.
 *
 * The parent's AbortSignal is reused so steers / shutdown propagate.
 * Branch-level events still emit through the parent's `emit`; the
 * executor stamps `nodeId` from the parent ctx, so branch-scoped
 * observability events carry the branch id via the handler writing
 * it into the payload.
 */
function buildBranchContext(childId: string, parent: HandlerContext): HandlerContext {
  return {
    ...parent,
    nodeId: childId,
    iteration: 0,
    routing: structuredClone(parent.routing as Record<string, unknown>),
  };
}

function findParallelParent(nodes: Record<string, Node>, fanInNodeId: string): string | null {
  for (const node of Object.values(nodes)) {
    if (node.attrs.shape !== "component") continue;
    if (node.attrs.fan_in === fanInNodeId) return node.id;
  }
  return null;
}

function malformedParallelSpec(nodeId: string): HandlerSpec {
  return {
    kind: "parallel",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `parallel node "${nodeId}" missing fan_in attr or has no branches`,
    }),
  };
}

function malformedWaitHumanSpec(nodeId: string, message: string): HandlerSpec {
  return {
    kind: "wait.human",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `wait.human node "${nodeId}": ${message}`,
    }),
  };
}

function malformedFanInSpec(nodeId: string): HandlerSpec {
  return {
    kind: "parallel.fan_in",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `fan_in node "${nodeId}" is not referenced by any component (parallel) node`,
    }),
  };
}

function specForNode(
  nodeId: string,
  edges: Array<{ to: string; label?: string }>,
  attrs: { shape?: string; type?: string; prompt?: string; label?: string; tool_command?: string },
  resolvedMaxMs: number | undefined,
): HandlerSpec {
  const first = edges[0]?.to ?? "__end__";
  const kind = handlerKindOf(attrs);

  switch (kind) {
    case "wait.human": {
      const options = edges.map((e) => {
        const lbl = e.label ?? e.to;
        return { key: handler.parseAcceleratorKey(lbl), label: lbl, to: e.to };
      });
      // Question text precedence: graphviz `label=` (the convention for
      // visible node text) → `prompt=` (legacy / shared with codergen)
      // → fallback. Authors who type `label="Approve?"` on a hexagon
      // expect that to be the operator-facing question.
      const questionLabel = attrs.label ?? attrs.prompt ?? `waiting at ${nodeId}`;
      try {
        return handler.makeWaitHumanHandler({
          label: questionLabel,
          options,
        });
      } catch (err) {
        return malformedWaitHumanSpec(nodeId, err instanceof Error ? err.message : String(err));
      }
    }
    case "tool": {
      const cmd = typeof attrs.tool_command === "string" ? attrs.tool_command : "";
      const toolOpts: Parameters<typeof handler.makeToolHandler>[0] = { toolCommand: cmd };
      if (resolvedMaxMs !== undefined) toolOpts.maxMs = resolvedMaxMs;
      return handler.makeToolHandler(toolOpts);
    }
    case "exit":
      return {
        kind: "exit",
        sideEffect: "none",
        maxMs: 50,
        handler: async () => ({
          kind: "transition",
          nextNode: "__end__",
          tokens: 0,
          costUsd: 0,
        }),
      };
    case "conditional":
      // Branching-point: no work beyond evaluating the outgoing edge
      // conditions against state.routing. Leaving nextNode unset lets
      // the executor's edge selector apply the 5-rule priority; empty
      // outcomeStatus defaults to "success" for unconditional fallthrough.
      return {
        kind: "conditional",
        sideEffect: "none",
        maxMs: 50,
        handler: async () => ({ kind: "transition", tokens: 0, costUsd: 0 }),
      };
    case "start":
      // Entry sentinel. Conventionally a single unconditional edge to
      // the first real node. Defer to the selector for consistency with
      // the rest of the graph — works correctly for the one-outgoing-
      // edge case AND for start nodes with conditions (rare but legal).
      return {
        kind: "start",
        sideEffect: "none",
        maxMs: 50,
        handler: async () => ({ kind: "transition", tokens: 0, costUsd: 0 }),
      };
    default:
      return transitionSpec(kind, first);
  }
}

function transitionSpec(kind: string, nextNode: string): HandlerSpec {
  return {
    kind,
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => ({
      kind: "transition",
      nextNode,
      tokens: 0,
      costUsd: 0,
    }),
  };
}

function handlerKindOf(attrs: { shape?: string; type?: string }): string {
  if (typeof attrs.type === "string" && attrs.type.length > 0) return attrs.type;
  switch (attrs.shape) {
    case "Mdiamond":
      return "start";
    case "Msquare":
      return "exit";
    case "diamond":
      return "conditional";
    case "hexagon":
      return "wait.human";
    case "parallelogram":
      return "tool";
    case "component":
      return "parallel";
    case "tripleoctagon":
      return "parallel.fan_in";
    default:
      return "codergen";
  }
}
