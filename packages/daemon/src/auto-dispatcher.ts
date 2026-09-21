// Auto-dispatcher: lazily builds HandlerSpecs from a workflow source.
//
// Used as a DispatcherResolver fallback so new workflows added via HTTP
// after daemon start get their nodes registered on first dispatch. Each
// node's spec is derived from its shape / `type` attribute.

import type { Graph, Node, NodeAttrs } from "@fragua/core";
import { InvalidDurationError, parseDurationMs } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import type { IEventReader } from "@fragua/store";
import type { DispatcherResolver } from "./dispatch.ts";
import { type GraphLoader, makeGraphLoader } from "./graph-loader.ts";

type HandlerSpec = handler.HandlerSpec;

export interface AutoDispatcherOpts {
  store: Pick<IEventReader, "getWorkflow">;
  /**
   * Optional shared parse-once boundary. When omitted, the resolver
   * builds one from `opts.store` so a caller that only passes `{ store }`
   * keeps working. The daemon passes a single shared loader so every run
   * across all workflows parses each sha once.
   */
  graphLoader?: GraphLoader;
  /**
   * Optional factory that builds a real llm handler for `llm`
   * nodes. When provided, the auto-dispatcher uses it instead of the
   * trivial noop transition so any llm node that reaches the daemon is
   * executed via a real LLM backend. `nextNode` is passed as a legacy
   * fallback for factories that don't rely on the executor's edge
   * selector; factories are free to ignore it. `maxMs` is resolved from
   * the node's `timeout=`/`max_ms=` attrs (see `resolveMaxMs` below);
   * factories forward it into the HandlerSpec.
   */
  codergenFactory?: (node: Node, nextNode: string, maxMs: number | "unbounded" | undefined) => HandlerSpec;
  /** Per-kind fallback `maxMs` when the workflow node declares neither
   * `timeout` nor `max_ms`. Keyed by handler kind (`llm`, `tool`).
   * Absent kind → handler's own built-in default applies. */
  defaultMaxMs?: { llm?: number; tool?: number; judge?: number };
}

/**
 * Resolve a handler's `maxMs` from a workflow node's attrs, falling back to
 * `fallbackMs` (per-kind config) and finally the handler's own default.
 * Precedence:
 *   1. `attrs.max_ms` — numeric literal in ms
 *   2. `attrs.timeout` — duration string ("30s", "5m", "2h", etc.)
 *   3. caller-supplied fallback (undefined → handler default applies)
 *
 * Returns `undefined` (a) when neither attr is set and `fallbackMs` is
 * undefined, OR (b) when an explicit `max_ms=0` / `timeout="0"` is set
 * (the unbounded sentinel for llm). The two cases collapse here;
 * `specsForGraph` re-inspects the raw attrs to distinguish them for the
 * llm factory.
 *
 * Malformed values reach this function only when the workflow was parsed
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
  // `timeouts.llm: 0` is the unbounded sentinel just like the
  // node-attr form. Without this, a `timeouts.llm: 0` in
  // `.fragua/config.yaml` resolves to a 0-ms abort timer.
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
  const loader = opts.graphLoader ?? makeGraphLoader(opts.store);

  return (workflowSha, nodeId) => {
    let specs = perWorkflow.get(workflowSha);
    if (specs == null) {
      const result = loader.load(workflowSha);
      if (!result.ok) return null;
      specs = specsForGraph(result.graph, opts.codergenFactory, opts.defaultMaxMs);
      perWorkflow.set(workflowSha, specs);
    }
    return specs.get(nodeId) ?? null;
  };
}

function specsForGraph(
  graph: Graph,
  codergenFactory?: AutoDispatcherOpts["codergenFactory"],
  defaultMaxMs?: AutoDispatcherOpts["defaultMaxMs"],
): Map<string, HandlerSpec> {
  const outgoing = new Map<string, Array<{ to: string; label?: string; route?: string }>>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    const edgeLabel = typeof edge.attrs.label === "string" ? edge.attrs.label : undefined;
    const edgeRoute = typeof edge.attrs.route === "string" ? edge.attrs.route : undefined;
    const entry: { to: string; label?: string; route?: string } = { to: edge.to };
    if (edgeLabel !== undefined) entry.label = edgeLabel;
    if (edgeRoute !== undefined) entry.route = edgeRoute;
    list.push(entry);
    outgoing.set(edge.from, list);
  }
  const specs = new Map<string, HandlerSpec>();

  for (const node of Object.values(graph.nodes)) {
    const kind: string = node.type;
    const edges = outgoing.get(node.id) ?? [];
    const first = edges[0]?.to ?? "__end__";
    let resolvedMaxMs: number | undefined;
    try {
      const fallback =
        kind === "llm"
          ? defaultMaxMs?.llm
          : kind === "tool"
            ? defaultMaxMs?.tool
            : kind === "judge"
              ? defaultMaxMs?.judge
              : undefined;
      resolvedMaxMs = resolveMaxMs(node.attrs, fallback);
    } catch (err) {
      if (err instanceof InvalidDurationError) {
        specs.set(node.id, errorSpec(kind, node.id, err.message));
        continue;
      }
      throw err;
    }
    const useFactory = kind === "llm" && codergenFactory != null;
    if (useFactory) {
      const codergenMaxMs: number | "unbounded" | undefined = explicitlyUnbounded(node.attrs)
        ? "unbounded"
        : resolvedMaxMs;
      specs.set(node.id, codergenFactory(node, first, codergenMaxMs));
    } else {
      specs.set(node.id, specForNode(node.id, kind, edges, node.attrs, resolvedMaxMs));
    }
  }

  return specs;
}

/** A spec whose only job is to halt the run with a clean, named error — for a
 * node whose attrs failed to resolve at dispatch (malformed timeout, a judge
 * missing its blocks, a human step with no usable routes). */
function errorSpec(kind: string, nodeId: string, message: string): HandlerSpec {
  return {
    kind,
    sideEffect: "none",
    maxMs: 50,
    handler: async () => ({
      kind: "halt",
      reason: "error",
      detail: `${kind} node "${nodeId}": ${message}`,
    }),
  };
}

function specForNode(
  nodeId: string,
  kind: string,
  edges: Array<{ to: string; label?: string; route?: string }>,
  attrs: NodeAttrs,
  resolvedMaxMs: number | undefined,
): HandlerSpec {
  const first = edges[0]?.to ?? "__end__";

  switch (kind) {
    case "human": {
      // Text precedence: explicit `text=` (canonical, post-Phase-7)
      // wins; `prompt=` / `label=` retained as fallbacks for
      // partially-migrated graphs. Validator E026 catches the inverse
      // misuse (text= on non-human nodes).
      const text = attrs.text ?? attrs.prompt ?? attrs.label ?? `waiting at ${nodeId}`;
      const routes = Array.isArray(attrs.routes) ? attrs.routes : [];
      // Only edges carrying `route=` participate; un-annotated edges
      // on a human node would be E020 at upload and never reach here
      // through the validated path.
      const humanEdges = edges
        .filter((e): e is { to: string; label?: string; route: string } => typeof e.route === "string")
        .map((e) =>
          e.label !== undefined ? { route: e.route, to: e.to, label: e.label } : { route: e.route, to: e.to },
        );
      try {
        return handler.makeHumanHandler({
          nodeId,
          text,
          routes,
          edges: humanEdges,
        });
      } catch (err) {
        return errorSpec("human", nodeId, err instanceof Error ? err.message : String(err));
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
    case "judge": {
      if (
        attrs.judge_questions === undefined ||
        (attrs.judge_state === undefined && attrs.judge_for_each === undefined)
      ) {
        return errorSpec("judge", nodeId, "missing judge_state / judge_questions (parsed without validation?)");
      }
      const judgeOpts: handler.JudgeConfig = {
        nodeId,
        questions: attrs.judge_questions,
      };
      if (attrs.judge_state !== undefined) judgeOpts.state = attrs.judge_state;
      if (attrs.judge_for_each !== undefined) judgeOpts.forEach = attrs.judge_for_each;
      if (attrs.judge_keep !== undefined) judgeOpts.keep = attrs.judge_keep;
      if (attrs.judge_composite !== undefined) judgeOpts.composites = attrs.judge_composite;
      if (attrs.judge_for_each_max_items !== undefined) judgeOpts.forEachMaxItems = attrs.judge_for_each_max_items;
      if (attrs.judge_decide !== undefined) judgeOpts.decide = attrs.judge_decide;
      if (attrs.judge_state_max_bytes !== undefined) judgeOpts.stateMaxBytes = attrs.judge_state_max_bytes;
      if (typeof attrs.model === "string") judgeOpts.model = attrs.model;
      if (resolvedMaxMs !== undefined) judgeOpts.maxMs = resolvedMaxMs;
      return handler.makeJudgeHandler(judgeOpts);
    }
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
