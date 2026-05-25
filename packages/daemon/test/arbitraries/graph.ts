// Workflow-graph arbitrary for property-based testing — see
// docs/proposals/executor-pbt-decomposition.md (Phase 7 north star).
//
// Generates the Graph IR directly (the executor's unit of consumption), NOT
// YAML — routing through the parser would couple two test targets and slow the
// loop. The generator mimics the parser's output discipline (synthesized
// start/exit, goal_gate as an attribute, one success successor per step) so it
// only emits graphs the parser could too.
//
// Construction is spine-first / back-edges-last: a topological skeleton
// (start → n1 → … → nk → exit) gives every node a forward success path to exit,
// which discharges reachability + exit-reachability + E032 + W006 by
// construction. Cycles enter only via fail/route back-edges, and goal gates are
// attribute-only (retry_target is not a graph edge), so neither can strand an
// SCC. Edge targets are bounded indices (`fc.integer({min,max})`) derived into
// ids — never raw ids, never post-filtered — so every shrink step stays a valid
// in-range target.
//
// Correctness is self-checking: `validate(graph)` is run as a post-condition on
// every generated graph (the bootstrap property), so a generator bug shrinks to
// a minimal counterexample rather than silently producing junk.
//
// Node kinds: llm + tool (the structural core — bare success edge + optional
// fail edge / back-edge cycle, attribute-only goal gates), plus routing-llm and
// human (route-keyed exits — the HITL + LLM-directed branch). Any node with a
// non-empty `routes:` follows the unified routing discipline (E017–E024): all
// outgoing edges route-keyed, exactly one per declared route, ≥1 forward for
// exit-reachability, never a goal gate. Also generated: budget ceilings
// (run-level budget_usd + budget_policy, node-level max_cost_usd / max_tokens),
// threads + summary (graph thread_id with node summary — E027 kept by always
// pairing summary with a thread), and an inputs: block with a declared
// `${{ inputs.in0 }}` reference (E030 kept by only referencing declared names).

import type { Edge, Graph, GraphAttrs, InputDecl, Node, NodeAttrs } from "@fragua/core";
import fc from "fast-check";

const MAX_BODY = 6;

export type NodeKind = "llm" | "tool" | "routing" | "human";

/** Per-body-node generation spec. Index-dependent fields (`retryTargetIdx`,
 * `failTarget`, route targets) are generated with bounds derived from the
 * node's position in the topo order, so they are always in-range and shrink
 * toward the minimum valid target. */
interface NodeSpec {
  kind: NodeKind;
  /** Wish to be a goal gate; honoured only for plain llm nodes at index ≥ 2 (a
   * goal gate needs an earlier node to retarget to, and is mutually exclusive
   * with routes= per E023, so never on a routing/human node). */
  gate: boolean;
  /** 1-based index of an earlier node, used as `retry_target` when this is a
   * gate. Bounded to `[1, i-1]` at generation. */
  retryTargetIdx: number;
  maxRetries: number;
  /** llm/tool only — optional fail edge: `undefined` = fail-halt, `0` = the
   * `exit` sink, `1..k` = a body node (upstream = back-edge cycle). Route
   * nodes carry no fail edge (E017 forbids outcome= edges on them). */
  failTarget: number | undefined;
  /** routing/human only — number of declared routes (`r0..r{n-1}`). */
  routeCount: number;
  /** routing/human only — targets for the non-spine routes (`r1..`). `0` =
   * exit, `1..k` = a body node. Route `r0` always takes the spine target to
   * preserve exit-reachability. Fixed-length 2 (max routeCount is 3); sliced. */
  extraRouteTargets: number[];
  /** llm/tool only — optional per-node cost / token ceilings (the node-level
   * budget gate). No validator rule beyond W013, so safe to attach freely. */
  maxCostUsd: number | undefined;
  maxTokens: number | undefined;
  /** plain-llm only — optional thread summariser level. Applied only when the
   * graph carries a thread_id (always paired below), keeping E027 satisfied. */
  summary: "low" | "medium" | "high" | undefined;
}

/** Run-level budget (graph attrs). `undefined` = no ceiling. */
interface BudgetSpec {
  usd: number;
  policy: "warn" | "stop" | "pause";
}

/** Graph-level generation spec — attrs that aren't per-node. */
interface GraphSpec {
  budget: BudgetSpec | undefined;
  /** Force a graph-level `thread_id` even when no node summarises. */
  thread: boolean;
  /** Declared `inputs:` count (`in0..in{n-1}`), 0 = no inputs block. */
  inputCount: number;
  /** Embed a `${{ inputs.in0 }}` reference in n1's prompt (only when inputs
   * are declared — keeps E030 clean). */
  embedInputRef: boolean;
}

function bodyId(i: number): string {
  return `n${i}`;
}

function nodeSpec(i: number, k: number, kinds: readonly NodeKind[]): fc.Arbitrary<NodeSpec> {
  const canGate = i >= 2;
  return fc.record({
    // constantFrom shrinks toward the first kind, so callers pass llm first.
    kind: fc.constantFrom<NodeKind>(...kinds),
    gate: canGate ? fc.boolean() : fc.constant(false),
    retryTargetIdx: canGate ? fc.integer({ min: 1, max: i - 1 }) : fc.constant(1),
    maxRetries: fc.integer({ min: 1, max: 5 }),
    failTarget: fc.option(fc.integer({ min: 0, max: k }), { nil: undefined }),
    routeCount: fc.integer({ min: 1, max: 3 }),
    extraRouteTargets: fc.array(fc.integer({ min: 0, max: k }), { minLength: 2, maxLength: 2 }),
    maxCostUsd: fc.option(fc.double({ min: 0.01, max: 50, noNaN: true }), { nil: undefined }),
    maxTokens: fc.option(fc.integer({ min: 1, max: 100_000 }), { nil: undefined }),
    summary: fc.option(fc.constantFrom<"low" | "medium" | "high">("low", "medium", "high"), { nil: undefined }),
  });
}

function buildGraph(specs: readonly NodeSpec[], g: GraphSpec): Graph {
  const k = specs.length;
  const graphAttrs: GraphAttrs = {};
  if (g.budget !== undefined) {
    graphAttrs.budget_usd = g.budget.usd;
    graphAttrs.budget_policy = g.budget.policy;
  }
  // A graph thread_id is set whenever requested OR any plain-llm node wants a
  // summary, so summary is never orphaned (E027: summary requires a thread).
  const anySummary = specs.some((s) => s.kind === "llm" && s.summary !== undefined);
  if (g.thread || anySummary) graphAttrs.thread_id = "main";
  if (g.inputCount > 0) {
    graphAttrs.inputs = Array.from(
      { length: g.inputCount },
      (_, j): InputDecl => ({ name: `in${j}`, type: "string", required: false }),
    );
  }

  const nodes: Record<string, Node> = {
    start: { id: "start", type: "start", attrs: { label: "start" } },
    exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
  };
  const edges: Edge[] = [{ from: "start", to: bodyId(1), attrs: {} }];
  const targetId = (t: number): string => (t === 0 ? "exit" : bodyId(t));

  for (let i = 1; i <= k; i++) {
    const spec = specs[i - 1]!;
    const id = bodyId(i);
    const spineTarget = i < k ? bodyId(i + 1) : "exit";
    // label is always set so an llm node never trips W009 (empty prompt+label).
    const attrs: NodeAttrs = { label: `step ${id}` };

    if (spec.kind === "routing" || spec.kind === "human") {
      // Route nodes (routing-llm and human) discriminate by route= only — no
      // bare, no outcome edges (E017/E020). One edge per declared route (E021),
      // each route value declared (E019), distinct (E024).
      const m = spec.routeCount;
      attrs.routes = Array.from({ length: m }, (_, j) => `r${j}`);
      if (spec.kind === "human") attrs.text = "choose"; // text= only on human (E026)
      nodes[id] = { id, type: spec.kind === "human" ? "human" : "llm", attrs };
      // r0 takes the spine target so the node keeps a forward path to exit.
      edges.push({ from: id, to: spineTarget, attrs: { route: "r0" } });
      for (let j = 1; j < m; j++) {
        edges.push({ from: id, to: targetId(spec.extraRouteTargets[j - 1]!), attrs: { route: `r${j}` } });
      }
      continue;
    }

    // Plain llm / tool: bare success spine + optional fail edge.
    if (spec.kind === "tool") attrs.tool_command = "true";
    if (spec.kind === "llm" && spec.gate && i >= 2) {
      attrs.goal_gate = true;
      attrs.retry_target = bodyId(spec.retryTargetIdx);
      attrs.max_retries = spec.maxRetries;
    }
    if (spec.maxCostUsd !== undefined) attrs.max_cost_usd = spec.maxCostUsd;
    if (spec.maxTokens !== undefined) attrs.max_tokens = spec.maxTokens;
    if (spec.kind === "llm" && spec.summary !== undefined) attrs.summary = spec.summary;
    nodes[id] = { id, type: spec.kind, attrs };
    edges.push({ from: id, to: spineTarget, attrs: {} });
    if (spec.failTarget !== undefined) {
      edges.push({ from: id, to: targetId(spec.failTarget), attrs: { outcome: "fail" } });
    }
  }

  // A declared input referenced from n1's prompt — exercises E030's clean path
  // (the ref is always a declared name).
  if (g.inputCount > 0 && g.embedInputRef) {
    nodes[bodyId(1)]!.attrs.prompt = "use ${{ inputs.in0 }}";
  }

  return { id: "g", directed: true, attrs: graphAttrs, nodes, edges };
}

const arbGraphSpec: fc.Arbitrary<GraphSpec> = fc.record({
  budget: fc.option(
    fc.record({
      usd: fc.double({ min: 0.01, max: 50, noNaN: true }),
      policy: fc.constantFrom<"warn" | "stop" | "pause">("warn", "stop", "pause"),
    }),
    { nil: undefined },
  ),
  thread: fc.boolean(),
  inputCount: fc.integer({ min: 0, max: 2 }),
  embedInputRef: fc.boolean(),
});

/** Whole-graph arbitrary over the given node kinds (default: all). The tier-2
 * driven harness passes a human-free set so a run reaches a terminal without a
 * HITL intent to answer the pause. */
export function makeArbGraph(kinds: readonly NodeKind[] = ["llm", "tool", "routing", "human"]): fc.Arbitrary<Graph> {
  return fc.integer({ min: 1, max: MAX_BODY }).chain((k) =>
    fc
      .record({
        graphSpec: arbGraphSpec,
        specs: fc.tuple(...Array.from({ length: k }, (_, idx) => nodeSpec(idx + 1, k, kinds))),
      })
      .map(({ graphSpec, specs }) => buildGraph(specs, graphSpec)),
  );
}

/** Whole-graph arbitrary over all node kinds (the tier-1 slice + bootstrap). */
export const arbGraph: fc.Arbitrary<Graph> = makeArbGraph();

/** Tier-1 slice for `planTransition`: a generated graph paired with one of its
 * non-terminal (llm/tool/human) nodes as the dispatch's `currentNode`. The
 * planner consumes the whole graph (edge selection + goal-gate checks run over
 * it), so the "slice" is `(graph, nodeId)` rather than a detached node. */
export const arbGraphWithCurrentNode: fc.Arbitrary<{ graph: Graph; nodeId: string }> = arbGraph.chain((graph) => {
  const bodyIds = Object.values(graph.nodes)
    .filter((n) => n.type === "llm" || n.type === "tool" || n.type === "human")
    .map((n) => n.id);
  return fc.constantFrom(...bodyIds).map((nodeId) => ({ graph, nodeId }));
});

/** Structural features a graph exhibits — fed to `fc.statistics` so the
 * coverage distribution is observable (without it a million 2-node chains feel
 * safe for no reason). */
export function featuresOf(graph: Graph): string[] {
  const out: string[] = [];
  const body = Object.values(graph.nodes).filter((n) => n.type !== "start" && n.type !== "exit");
  out.push(`nodes=${body.length}`);
  if (body.some((n) => n.type === "tool")) out.push("has-tool");
  if (body.some((n) => n.type === "human")) out.push("has-human");
  if (body.some((n) => n.type === "llm" && Array.isArray(n.attrs.routes) && n.attrs.routes.length > 0)) {
    out.push("has-routing");
  }
  if (body.some((n) => Array.isArray(n.attrs.routes) && n.attrs.routes.length >= 2)) out.push("has-route-fanout");
  if (body.some((n) => n.attrs.goal_gate === true)) out.push("has-goal-gate");
  if (
    graph.attrs.budget_usd !== undefined ||
    body.some((n) => n.attrs.max_cost_usd !== undefined || n.attrs.max_tokens !== undefined)
  ) {
    out.push("has-budget");
  }
  if (graph.attrs.thread_id !== undefined) out.push("has-thread");
  if (body.some((n) => typeof n.attrs.summary === "string")) out.push("has-summary");
  if (Array.isArray(graph.attrs.inputs) && graph.attrs.inputs.length > 0) out.push("has-inputs");

  const failEdges = graph.edges.filter((e) => e.attrs.outcome === "fail");
  if (failEdges.length > 0) out.push("has-fail-edge");
  // A back-edge / self-loop — fail or route edge to an equal-or-earlier index.
  const idx = (id: string): number => (id.startsWith("n") ? Number(id.slice(1)) : Number.NaN);
  if (graph.edges.some((e) => e.to !== "exit" && e.from.startsWith("n") && idx(e.to) <= idx(e.from))) {
    out.push("has-cycle");
  }
  if (
    body.some(
      (n) =>
        (n.type === "llm" || n.type === "tool") &&
        !graph.edges.some((e) => e.from === n.id && e.attrs.outcome === "fail"),
    )
  ) {
    out.push("has-fail-halt");
  }
  return out;
}
