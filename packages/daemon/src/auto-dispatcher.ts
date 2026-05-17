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

import type { DiscoveryResult, Node, NodeAttrs } from "@swarm/core";
import {
  discoverFanInTarget,
  findParallelParent,
  InvalidDurationError,
  parseDotSource,
  parseDurationMs,
  prepareGraph,
} from "@swarm/core";
import type { LlmFanInDelegate } from "@swarm/core/handler";
import * as handler from "@swarm/core/handler";
import type { IEventStore } from "@swarm/store";
import type { DispatcherResolver } from "./dispatch.ts";

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
   * the node's `timeout=`/`max_ms=` attrs (see `resolveMaxMs` below);
   * factories forward it into the HandlerSpec.
   */
  codergenFactory?: (node: Node, nextNode: string, maxMs: number | "unbounded" | undefined) => HandlerSpec;
  /** Per-kind fallback `maxMs` when the DOT node declares neither
   * `timeout` nor `max_ms`. Keyed by handler kind (`codergen`, `tool`).
   * Absent kind → handler's own built-in default applies. */
  defaultMaxMs?: { codergen?: number; tool?: number };
  /**
   * Optional delegate that drives an LLM evaluation when a
   * `tripleoctagon` node carries a non-empty `prompt=` attribute.
   * When absent, tripleoctagons with `prompt=` produce a halt spec
   * at construction time (attractor §4.9 LLM-eval path).
   */
  fanInLlmDelegate?: LlmFanInDelegate;
}

/**
 * Resolve a handler's `maxMs` from a DOT node's attrs, falling back to
 * `fallbackMs` (per-kind config) and finally the handler's own default.
 * Precedence:
 *   1. `attrs.max_ms` — numeric literal in ms
 *   2. `attrs.timeout` — duration string ("30s", "5m", "2h", etc.)
 *   3. caller-supplied fallback (undefined → handler default applies)
 *
 * Returns `undefined` (a) when neither attr is set and `fallbackMs` is
 * undefined, OR (b) when an explicit `max_ms=0` / `timeout="0"` is set
 * (the unbounded sentinel for codergen — see
 * docs/proposals/codergen-unbounded-time.md). The two cases collapse here;
 * `specsForGraph` re-inspects the raw attrs to distinguish them for the
 * codergen factory.
 *
 * Malformed values reach this function only when the DOT was parsed
 * without enqueue-time validation (tests, direct-store inserts). We
 * surface the parse error as a thrown `InvalidDurationError` — callers
 * use `malformed*Spec` to return a clean halt fact instead of crashing
 * the dispatcher.
 */
export function resolveMaxMs(attrs: NodeAttrs, fallbackMs: number | undefined): number | undefined {
  if (typeof attrs.max_ms === "number") {
    const ms = parseDurationMs(attrs.max_ms);
    return ms === 0 ? undefined : ms;
  }
  if (typeof attrs.timeout === "string") {
    const ms = parseDurationMs(attrs.timeout);
    return ms === 0 ? undefined : ms;
  }
  // Same 0→undefined collapse on the fallback path: config-level
  // `timeouts.codergen: 0` is the unbounded sentinel just like the
  // node-attr form. Without this, a `timeouts.codergen: 0` in
  // `.swarm/config.jsonc` resolves to a 0-ms abort timer.
  return fallbackMs === 0 ? undefined : fallbackMs;
}

function explicitlyUnbounded(attrs: NodeAttrs): boolean {
  if (typeof attrs.max_ms === "number" && parseDurationMs(attrs.max_ms) === 0) return true;
  if (typeof attrs.timeout === "string" && parseDurationMs(attrs.timeout) === 0) return true;
  return false;
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
      specs = specsForGraph(workflow.dotSource, opts.codergenFactory, opts.defaultMaxMs, opts.fanInLlmDelegate);
      perWorkflow.set(workflowSha, specs);
    }
    return specs.get(nodeId) ?? null;
  };
}

function specsForGraph(
  dotSource: string,
  codergenFactory?: AutoDispatcherOpts["codergenFactory"],
  defaultMaxMs?: AutoDispatcherOpts["defaultMaxMs"],
  fanInLlmDelegate?: LlmFanInDelegate,
): Map<string, HandlerSpec> {
  const graph = parseDotSource(dotSource);
  // Apply transforms (stylesheet, …) so node.attrs reflect the resolved
  // configuration before per-node specs are derived. Stylesheet syntax
  // errors are caught at upload via E015; here we just apply silently.
  prepareGraph(graph);
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
    if (useFactory) {
      const codergenMaxMs: number | "unbounded" | undefined = explicitlyUnbounded(node.attrs)
        ? "unbounded"
        : resolvedMaxMs;
      specs.set(node.id, codergenFactory(node, first, codergenMaxMs));
    } else {
      specs.set(node.id, specForNode(node.id, edges, node.attrs, resolvedMaxMs));
    }
  }

  // Pass 2: parallel + fan_in, which need cross-node references. Per
  // attractor §4.8, branches are sub-executions that terminate at a
  // converging `tripleoctagon` — discovered structurally via edges, not
  // via a swarm-only `fan_in` attribute (dropped in PR P).
  for (const node of Object.values(graph.nodes)) {
    const kind = handlerKindOf(node.attrs);
    if (kind === "parallel") {
      const discovery = discoverFanInTarget(graph, node.id);
      if (discovery.kind !== "ok") {
        // Validator flags these at authoring; at runtime we halt with a
        // clear message rather than silently no-op into a bad state.
        specs.set(node.id, malformedParallelSpec(node.id, describeDiscoveryFailure(discovery)));
        continue;
      }
      const joinPolicy = node.attrs.join_policy === "first_success" ? "first_success" : "wait_all";
      specs.set(
        node.id,
        handler.makeParallelHandler({
          children: discovery.branches,
          fanInNode: discovery.fanInNode,
          joinPolicy,
        }),
      );
    } else if (kind === "parallel.fan_in") {
      const parallelNodeId = findParallelParent(graph, node.id);
      if (parallelNodeId == null) {
        specs.set(node.id, malformedFanInSpec(node.id));
        continue;
      }
      const rawPrompt = typeof node.attrs.prompt === "string" ? node.attrs.prompt.trim() : "";
      if (rawPrompt.length > 0) {
        if (fanInLlmDelegate == null) {
          specs.set(
            node.id,
            malformedFanInSpec(
              node.id,
              "prompt= set but no LLM delegate configured — start the daemon with --llm-provider/--llm-model",
            ),
          );
          continue;
        }
        specs.set(
          node.id,
          handler.makeFanInHandler({
            parallelNodeId,
            evaluator: {
              kind: "llm",
              prompt: node.attrs.prompt as string,
              delegate: fanInLlmDelegate,
              nodeAttrs: node.attrs,
            },
          }),
        );
      } else {
        specs.set(node.id, handler.makeFanInHandler({ parallelNodeId }));
      }
    }
  }

  return specs;
}

function describeDiscoveryFailure(d: DiscoveryResult): string {
  if (d.kind === "no-branches") return "has no outgoing branches";
  if (d.kind === "no-fan-in") return "no tripleoctagon (parallel.fan_in) reachable from any branch";
  if (d.kind === "ambiguous-fan-in") return `multiple tripleoctagons reachable: ${d.candidates.join(", ")}`;
  if (d.kind === "branches-diverge") return "branches converge on different tripleoctagons";
  return "unknown discovery failure";
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

function malformedParallelSpec(nodeId: string, reason = "missing branches or fan-in"): HandlerSpec {
  return {
    kind: "parallel",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `parallel node "${nodeId}": ${reason}`,
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

function malformedFanInSpec(nodeId: string, reason?: string): HandlerSpec {
  const detail = reason ?? `fan_in node "${nodeId}" is not referenced by any component (parallel) node`;
  return {
    kind: "parallel.fan_in",
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `fan_in "${nodeId}": ${detail}`,
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
