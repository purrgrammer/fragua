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
// construction. Cycles enter only via fail back-edges, and goal gates are
// attribute-only (retry_target is not a graph edge), so neither can strand an
// SCC. Edge targets are bounded indices (`fc.integer({min,max})`) derived into
// ids — never raw ids, never post-filtered — so every shrink step stays a valid
// in-range target.
//
// Correctness is self-checking: `validate(graph)` is run as a post-condition on
// every generated graph (the bootstrap property), so a generator bug shrinks to
// a minimal counterexample rather than silently producing junk.
//
// Phase 1 (here): llm + tool nodes, forward spine, optional fail edges
// (back-edge cycles / fail-halt), attribute-only goal gates, exit. Routing
// nodes, human pauses, threads/summary, budget ceilings, and inputs layer on
// in a second pass — each additive, each re-checked against the validator.

import type { Edge, Graph, Node, NodeAttrs } from "@fragua/core";
import fc from "fast-check";

const MAX_BODY = 6;

/** Per-body-node generation spec. Index-dependent fields (`retryTargetIdx`,
 * `failTarget`) are generated with bounds derived from the node's position in
 * the topo order, so they are always in-range and shrink toward the minimum
 * valid target. */
interface NodeSpec {
  type: "llm" | "tool";
  /** Wish to be a goal gate; honoured only for llm nodes at index ≥ 2 (a goal
   * gate needs an earlier node to retarget to). */
  gate: boolean;
  /** 1-based index of an earlier node, used as `retry_target` when this is a
   * gate. Bounded to `[1, i-1]` at generation. */
  retryTargetIdx: number;
  maxRetries: number;
  /** Optional fail edge target: `undefined` = fail-halt (no fail edge), `0` =
   * route to the `exit` sink, `1..k` = a body node (upstream = back-edge
   * cycle, downstream = forward branch, self = self-loop). */
  failTarget: number | undefined;
}

function bodyId(i: number): string {
  return `n${i}`;
}

function nodeSpec(i: number, k: number): fc.Arbitrary<NodeSpec> {
  const canGate = i >= 2;
  return fc.record({
    type: fc.constantFrom<"llm" | "tool">("llm", "tool"),
    gate: canGate ? fc.boolean() : fc.constant(false),
    retryTargetIdx: canGate ? fc.integer({ min: 1, max: i - 1 }) : fc.constant(1),
    maxRetries: fc.integer({ min: 1, max: 5 }),
    failTarget: fc.option(fc.integer({ min: 0, max: k }), { nil: undefined }),
  });
}

function buildGraph(specs: readonly NodeSpec[]): Graph {
  const k = specs.length;
  const nodes: Record<string, Node> = {
    start: { id: "start", type: "start", attrs: { label: "start" } },
    exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
  };
  const edges: Edge[] = [{ from: "start", to: bodyId(1), attrs: {} }];

  for (let i = 1; i <= k; i++) {
    const spec = specs[i - 1]!;
    const id = bodyId(i);
    // label is always set so an llm node never trips W009 (empty prompt+label).
    const attrs: NodeAttrs = { label: `step ${id}` };
    if (spec.type === "tool") attrs.tool_command = "true";
    const isGate = spec.type === "llm" && spec.gate && i >= 2;
    if (isGate) {
      attrs.goal_gate = true;
      attrs.retry_target = bodyId(spec.retryTargetIdx);
      attrs.max_retries = spec.maxRetries;
    }
    nodes[id] = { id, type: spec.type, attrs };

    // The spine success edge — every non-terminal step's guaranteed forward
    // path (E032 + exit-reachability). Bare = success-keyed.
    edges.push({ from: id, to: i < k ? bodyId(i + 1) : "exit", attrs: {} });

    // Optional fail edge. Distinct discriminator (outcome:fail) from the bare
    // spine edge, so the pair never trips W005/E024 even when both point at the
    // same target.
    if (spec.failTarget !== undefined) {
      edges.push({
        from: id,
        to: spec.failTarget === 0 ? "exit" : bodyId(spec.failTarget),
        attrs: { outcome: "fail" },
      });
    }
  }

  return { id: "g", directed: true, attrs: {}, nodes, edges };
}

/** Whole-graph arbitrary (the tier-2 driven-executor harness consumes this). */
export const arbGraph: fc.Arbitrary<Graph> = fc
  .integer({ min: 1, max: MAX_BODY })
  .chain((k) => fc.tuple(...Array.from({ length: k }, (_, idx) => nodeSpec(idx + 1, k))).map(buildGraph));

/** Tier-1 slice for `planTransition`: a generated graph paired with one of its
 * non-terminal (llm/tool) nodes as the dispatch's `currentNode`. The planner
 * consumes the whole graph (it runs edge selection + goal-gate checks over it),
 * so the "slice" is `(graph, nodeId)` rather than a detached node. */
export const arbGraphWithCurrentNode: fc.Arbitrary<{ graph: Graph; nodeId: string }> = arbGraph.chain((graph) => {
  const bodyIds = Object.values(graph.nodes)
    .filter((n) => n.type === "llm" || n.type === "tool")
    .map((n) => n.id);
  return fc.constantFrom(...bodyIds).map((nodeId) => ({ graph, nodeId }));
});

/** Structural features a graph exhibits — fed to `fc.statistics` so the
 * coverage distribution is observable (without it a million 2-node chains feel
 * safe for no reason). */
export function featuresOf(graph: Graph): string[] {
  const out: string[] = [];
  const body = Object.values(graph.nodes).filter((n) => n.type === "llm" || n.type === "tool");
  out.push(`nodes=${body.length}`);
  if (body.some((n) => n.type === "tool")) out.push("has-tool");
  if (body.some((n) => n.attrs.goal_gate === true)) out.push("has-goal-gate");

  const failEdges = graph.edges.filter((e) => e.attrs.outcome === "fail");
  if (failEdges.length > 0) out.push("has-fail-edge");
  // A fail edge to an equal-or-earlier topo index is a cycle (back-edge / self).
  const idx = (id: string): number => (id.startsWith("n") ? Number(id.slice(1)) : Number.NaN);
  if (failEdges.some((e) => e.to !== "exit" && idx(e.to) <= idx(e.from))) out.push("has-cycle");
  // A body node with no fail edge fails by halting.
  if (body.some((n) => !graph.edges.some((e) => e.from === n.id && e.attrs.outcome === "fail"))) {
    out.push("has-fail-halt");
  }
  return out;
}
