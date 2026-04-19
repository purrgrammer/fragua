// Auto-dispatcher: lazily builds HandlerSpecs from a workflow's DOT source.
//
// Used as a DispatcherResolver fallback so new workflows added via HTTP
// after daemon start get their nodes registered on first dispatch. Each
// node's spec is derived from its shape / `type` attribute.
//
// This is the "any valid DOT runs" demo fallback. Handlers just transition
// forward so the executor can move the state machine. Real runtime usage
// plugs a richer dispatcher built from packages/agent's backends.

import { handler, parseDotSource } from "@swarm/core";
import type { Node } from "@swarm/core";
import type { IEventStore } from "@swarm/store";
import type { DispatcherResolver } from "./dispatch.ts";

type HandlerSpec = handler.HandlerSpec;

export interface AutoDispatcherOpts {
  store: IEventStore;
  /**
   * Optional factory that builds a real codergen handler for `box`-shape
   * nodes. When provided, the auto-dispatcher uses it instead of the
   * trivial noop transition so any box node that reaches the daemon is
   * executed via a real LLM backend.
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
  for (const node of Object.values(graph.nodes)) {
    const first = outgoing.get(node.id)?.[0] ?? "__end__";
    const kind = handlerKindOf(node.attrs);
    const useFactory = kind === "codergen" && codergenFactory != null;
    specs.set(
      node.id,
      useFactory
        ? codergenFactory(node, first)
        : specForNode(node.id, outgoing.get(node.id) ?? [], node.attrs),
    );
  }
  return specs;
}

function specForNode(
  nodeId: string,
  outbound: string[],
  attrs: { shape?: string; type?: string; prompt?: string },
): HandlerSpec {
  const first = outbound[0] ?? "__end__";
  const kind = handlerKindOf(attrs);

  switch (kind) {
    case "wait.human":
      return handler.makeWaitHumanHandler({
        prompt: attrs.prompt ?? `waiting at ${nodeId}`,
        nextNode: first,
      });
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
    case "house":
      return "stack.manager_loop";
    case "trapezium":
      return "loop";
    case "box":
    default:
      return "codergen";
  }
}
