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

import type { Node } from "@swarm/core";
import { parseDotSource } from "@swarm/core";
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
   * selector; factories are free to ignore it.
   */
  codergenFactory?: (node: Node, nextNode: string) => HandlerSpec;
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
      specs = specsForGraph(workflow.dotSource, opts.codergenFactory);
      perWorkflow.set(workflowSha, specs);
    }
    return specs.get(nodeId) ?? null;
  };
}

function specsForGraph(
  dotSource: string,
  codergenFactory?: (node: Node, nextNode: string) => HandlerSpec,
): Map<string, HandlerSpec> {
  const graph = parseDotSource(dotSource);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const specs = new Map<string, HandlerSpec>();

  // Pass 1: leaf handler kinds.
  for (const node of Object.values(graph.nodes)) {
    const kind = handlerKindOf(node.attrs);
    if (kind === "parallel" || kind === "parallel.fan_in") continue;
    const first = outgoing.get(node.id)?.[0] ?? "__end__";
    const useFactory = kind === "codergen" && codergenFactory != null;
    specs.set(
      node.id,
      useFactory ? codergenFactory(node, first) : specForNode(node.id, outgoing.get(node.id) ?? [], node.attrs),
    );
  }

  // Pass 2: parallel + fan_in, which need cross-node references.
  for (const node of Object.values(graph.nodes)) {
    const kind = handlerKindOf(node.attrs);
    if (kind === "parallel") {
      const children = outgoing.get(node.id) ?? [];
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
  outbound: string[],
  attrs: { shape?: string; type?: string; prompt?: string; tool_command?: string },
): HandlerSpec {
  const first = outbound[0] ?? "__end__";
  const kind = handlerKindOf(attrs);

  switch (kind) {
    case "wait.human":
      return handler.makeWaitHumanHandler({
        prompt: attrs.prompt ?? `waiting at ${nodeId}`,
        nextNode: first,
      });
    case "tool": {
      // `timeout` attr is a duration string (e.g. "2m"); not yet parsed —
      // tool handler falls back to its 5-minute default. Workflows that
      // need a tighter / wider window must register the spec manually
      // via Dispatcher.register until duration-string parsing lands.
      const cmd = typeof attrs.tool_command === "string" ? attrs.tool_command : "";
      return handler.makeToolHandler({ toolCommand: cmd });
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
