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
//
// Beyond the spine, `makeArbGraph` mixes in (default-on, via fc.oneof) two
// engine-feature shapes so the validate() bootstrap exercises them:
//   (a) STRUCTURED OUTPUTS — an llm step declaring typed `outputs:` (scalar /
//       choice / array / record over the shared grammar) plus a downstream step
//       reading `${{ outputs.<producer>.<field>[.<sub>] }}`. The producer
//       dominates the consumer on the linear spine and the read lands on a
//       required leaf, so no E035 / W015 / W016.
//   (b) PARALLEL FAN-OUT — a `type: parallel` node with ≥2 distinct read-class
//       llm branch sub-pipelines (1–2 nodes each) converging on a join that
//       reads each branch terminal's typed outputs. Satisfies E036–E043: ≥2
//       distinct entries, disjoint closures reaching the join, llm + read-class
//       (allowed-tools: [read]) branch nodes, no nested parallel, no explicit
//       thread; the join's reads are dominated by the wait_all barrier (W015
//       suppressed). The executor-driving harnesses DRIVE this shape — their
//       scripted handlers emit declared `outputs:` via `stubOutputsFor`, so the
//       fan-out frontier reaches a clean terminal under crash + fault injection.
//       Only the structured-outputs SPINE shape (a) stays driver-opted-out: its
//       `${{…}}` refs land on routing/back-edge nodes the scripts don't populate.

import type {
  Edge,
  Graph,
  GraphAttrs,
  InputDecl,
  Node,
  NodeAttrs,
  OutputProfile,
  OutputStructValue,
  OutputsDecl,
  OutputsValue,
} from "@fragua/core";
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

// ─────────────── Structured outputs (a) ───────────────
//
// A producer llm step declares typed `outputs:` over the shared scalar/choice/
// record grammar (types/outputs.ts), and a DOWNSTREAM step reads one of those
// fields via `${{ outputs.<producer>.<field>[.<sub>] }}`. The producer
// dominates the consumer on a linear spine, so the read is dominant — no W015,
// no W016 (the read targets a REQUIRED scalar/choice leaf, never an optional
// field), and the ref resolves to a declared field — no E035. E033/E034 stay
// clean: ≥1 field, identifier keys, every choice/record non-empty.

/** A single output field profile + the dotted-path SUFFIX a consumer would read
 * to land on a required scalar/choice leaf. For a scalar/choice the suffix is
 * empty (`${{ outputs.X.field }}`); for a record it is `.<sub>` onto a required
 * scalar subfield (`${{ outputs.X.field.sub }}`). Records keep the leaf required
 * so the read never trips W016. */
interface OutputFieldSpec {
  profile: OutputProfile;
  /** Dotted path AFTER the top-level field name (e.g. `["sub"]`), used to build
   * a dominant, fail-open-free consumer reference. Empty for scalar/choice. */
  readSuffix: string[];
}

const arbScalarProfile: fc.Arbitrary<OutputProfile> = fc.oneof(
  fc.constant<OutputProfile>({ kind: "string" }),
  fc.constant<OutputProfile>({ kind: "number" }),
  fc.constant<OutputProfile>({ kind: "boolean" }),
  // ≥1 distinct option (E033). De-dup so `choiceFromOptions` never collapses.
  fc
    .uniqueArray(fc.constantFrom("a", "b", "c", "yes", "no", "maybe"), { minLength: 1, maxLength: 4 })
    .map((options): OutputProfile => ({ kind: "choice", options })),
);

/** A readable output field: a scalar/choice (read directly), an array of a
 * scalar (read whole — JSON), or a record with a REQUIRED scalar subfield the
 * consumer dots into. The `readSuffix` always lands on a required scalar/choice
 * leaf so the consumer's ref is dominant and never fails closed. */
const arbOutputField: fc.Arbitrary<OutputFieldSpec> = fc.oneof(
  { weight: 3, arbitrary: arbScalarProfile.map((profile) => ({ profile, readSuffix: [] as string[] })) },
  {
    weight: 1,
    arbitrary: arbScalarProfile.map((items) => ({
      profile: { kind: "array", items } satisfies OutputProfile,
      // Reading an array whole renders canonical JSON — still dominant, no W016.
      readSuffix: [] as string[],
    })),
  },
  {
    weight: 1,
    arbitrary: arbScalarProfile.map((sub) => ({
      // A record whose `sub` field is REQUIRED (default: every field required).
      profile: { kind: "record", fields: { sub }, required: ["sub"] } satisfies OutputProfile,
      readSuffix: ["sub"],
    })),
  },
);

/** A small `outputs:` block (1–2 fields), plus the consumer reference suffix for
 * the FIRST field (`field0` + its `readSuffix`). The consumer reads only that
 * first field so the reference is unambiguous and dominant. */
const arbOutputsDecl: fc.Arbitrary<{ decl: OutputsDecl; readPath: string[] }> = fc
  .array(arbOutputField, { minLength: 1, maxLength: 2 })
  .map((fields) => {
    const decl: OutputsDecl = {};
    fields.forEach((f, j) => {
      decl[`field${j}`] = f.profile;
    });
    return { decl, readPath: ["field0", ...fields[0]!.readSuffix] };
  });

/** Spine graph carrying structured outputs: `start → p(outputs) → c(consumes)
 * → exit`, plus 0–2 trailing plain llm nodes so the producer isn't always the
 * penultimate step. The producer `p` declares `outputs:`; the consumer `c` reads
 * `${{ outputs.p.<readPath> }}` in its prompt. Producer dominates consumer
 * (linear), so no W015/W016; the ref is declared, so no E035. */
const arbOutputsGraph: fc.Arbitrary<Graph> = fc
  .record({ outputs: arbOutputsDecl, tail: fc.integer({ min: 0, max: 2 }) })
  .map(({ outputs, tail }) => {
    const ref = `\${{ outputs.p.${outputs.readPath.join(".")} }}`;
    const nodes: Record<string, Node> = {
      start: { id: "start", type: "start", attrs: { label: "start" } },
      p: { id: "p", type: "llm", attrs: { label: "produce", prompt: "produce typed outputs", outputs: outputs.decl } },
      c: { id: "c", type: "llm", attrs: { label: "consume", prompt: `combine ${ref}` } },
      exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
    };
    const edges: Edge[] = [
      { from: "start", to: "p", attrs: {} },
      { from: "p", to: "c", attrs: {} },
    ];
    let prev = "c";
    for (let j = 0; j < tail; j++) {
      const id = `t${j}`;
      nodes[id] = { id, type: "llm", attrs: { label: id, prompt: id } };
      edges.push({ from: prev, to: id, attrs: {} });
      prev = id;
    }
    edges.push({ from: prev, to: "exit", attrs: {} });
    return { id: "g", directed: true, attrs: {}, nodes, edges };
  });

// ─────────────── Parallel fan-out (b) ───────────────
//
// `start → fan(parallel) → [branch entries] → join → exit`. The `fan` node
// carries `branches: [entry…]` (≥2 distinct) + `join:`; its `parallel → entry`
// edges are `{ fanout: true }` (mirrors the parser: only the take-all edges are
// flagged; the terminal → join barrier edge is an ordinary success edge the
// validator's closure BFS walks). Each branch is a read-class llm sub-pipeline
// (1–2 distinct llm nodes, `allowed-tools: [read]` so no E042, no `thread:` so
// no E043) whose terminal declares `outputs: { findings }` and routes to the
// join. The join is an ordinary llm reading every branch terminal's
// `${{ outputs.<terminal>.findings }}` — the wait_all barrier dominates the
// join, so W015 is suppressed for those reads (E036–E043 all satisfied).

interface BranchSpec {
  /** 1 = single-node branch (entry → join); 2 = two-node (entry → mid → join). */
  length: 1 | 2;
}

/** Build the parallel graph from N branch specs (N ≥ 2). Branch k owns node ids
 * `b{k}` (entry) and, when two-node, `b{k}m` (mid); the terminal of each branch
 * declares + would emit `findings`. */
function buildParallelGraph(branchSpecs: readonly BranchSpec[]): Graph {
  const findings: OutputsDecl = { findings: { kind: "string" } };
  const readClass: NodeAttrs["allowed_tools"] = ["read"];

  const nodes: Record<string, Node> = {
    start: { id: "start", type: "start", attrs: { label: "start" } },
    join: { id: "join", type: "llm", attrs: { label: "join" } },
    exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
  };
  const edges: Edge[] = [{ from: "start", to: "fan", attrs: {} }];

  const entries: string[] = [];
  const terminals: string[] = [];
  branchSpecs.forEach((spec, k) => {
    const entry = `b${k}`;
    entries.push(entry);
    const terminal = spec.length === 2 ? `b${k}m` : entry;
    terminals.push(terminal);
    // The terminal declares the outputs the join reads; non-terminal branch
    // nodes are plain read-class llm steps. All carry a label (no W009).
    nodes[entry] = {
      id: entry,
      type: "llm",
      attrs:
        spec.length === 1
          ? { label: entry, prompt: "scan", allowed_tools: readClass, outputs: findings }
          : { label: entry, prompt: "scan", allowed_tools: readClass },
    };
    if (spec.length === 2) {
      edges.push({ from: entry, to: terminal, attrs: {} });
      nodes[terminal] = {
        id: terminal,
        type: "llm",
        attrs: { label: terminal, prompt: "verify", allowed_tools: readClass, outputs: findings },
      };
    }
    // Barrier edge: terminal → join (ordinary success edge, NOT fanout-flagged —
    // the closure BFS must see it to discharge E039).
    edges.push({ from: terminal, to: "join", attrs: {} });
  });

  // The `fan` parallel node: branches + join attr; one fanout edge per entry.
  nodes["fan"] = { id: "fan", type: "parallel", attrs: { label: "fan", branches: entries, join: "join" } };
  for (const entry of entries) edges.push({ from: "fan", to: entry, attrs: { fanout: true } });

  // The join reads each branch terminal's findings (dominant via the barrier —
  // W015 suppressed). Distinct terminals → distinct refs.
  const reads = terminals.map((t) => `\${{ outputs.${t}.findings }}`).join(" ");
  nodes["join"]!.attrs.prompt = `synthesize ${reads}`;
  edges.push({ from: "join", to: "exit", attrs: {} });

  return { id: "g", directed: true, attrs: {}, nodes, edges };
}

const arbParallelGraph: fc.Arbitrary<Graph> = fc
  .array(fc.record({ length: fc.constantFrom<1 | 2>(1, 2) }), { minLength: 2, maxLength: 3 })
  .map((branchSpecs) => buildParallelGraph(branchSpecs));

/** A schema-valid stub value for one declared output profile — the smallest
 * thing that passes the lowered TypeBox. Lets a scripted PBT handler settle a
 * node that declares typed `outputs:` so its consumers resolve (no fail-closed
 * `UnpopulatedOutputError`). Covers the whole profile grammar so it works for
 * both the `outputs:` and `parallel` arbitraries. */
export function stubOutputValue(profile: OutputProfile): OutputStructValue {
  switch (profile.kind) {
    case "number":
      return 1;
    case "boolean":
      return true;
    case "choice":
      return profile.options[0] ?? "x";
    case "record": {
      const obj: Record<string, OutputStructValue> = {};
      for (const [field, sub] of Object.entries(profile.fields)) obj[field] = stubOutputValue(sub);
      return obj;
    }
    case "array":
      return [stubOutputValue(profile.items)];
    default:
      return "x"; // string
  }
}

/** Stub the full `outputs:` block a node declares (or `undefined` when it
 * declares none), for emission on a scripted handler's success transition. */
export function stubOutputsFor(node: Node): OutputsValue | undefined {
  const decl = node.attrs.outputs;
  if (decl === undefined) return undefined;
  const out: OutputsValue = {};
  for (const [field, profile] of Object.entries(decl)) out[field] = stubOutputValue(profile);
  return out;
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

/** The spine-based graph (start → n1 → … → exit + back-edges/gates/routes). The
 * structural core; `makeArbGraph` mixes the outputs / parallel shapes on top. */
function arbSpineGraph(kinds: readonly NodeKind[]): fc.Arbitrary<Graph> {
  return fc.integer({ min: 1, max: MAX_BODY }).chain((k) =>
    fc
      .record({
        graphSpec: arbGraphSpec,
        specs: fc.tuple(...Array.from({ length: k }, (_, idx) => nodeSpec(idx + 1, k, kinds))),
      })
      .map(({ graphSpec, specs }) => buildGraph(specs, graphSpec)),
  );
}

/** Knobs for the extra (non-spine) graph shapes. Both default ON for the
 * bootstrap (the validate() target exercises them). The executor-driving
 * harnesses (driven / fault / transition-planner) pass `false` because their
 * scripted handlers neither emit typed outputs nor run the fan-out frontier, so
 * an outputs-consumer / parallel graph wouldn't reach a clean terminal under
 * them — validity is the property here, drivability is theirs. */
export interface ArbGraphOptions {
  /** Mix in `start → p(outputs) → c(consumes ${{ outputs.p.f }}) → exit` graphs. */
  structuredOutputs?: boolean;
  /** Mix in `start → fan(parallel) → [read-class llm branches] → join → exit` graphs. */
  parallel?: boolean;
}

/** Whole-graph arbitrary over the given node kinds (default: all). The tier-2
 * driven harness passes a human-free set so a run reaches a terminal without a
 * HITL intent to answer the pause. With `opts.structuredOutputs` / `opts.parallel`
 * (default true) the result is an `fc.oneof` that ALSO emits typed-outputs and
 * `type: parallel` fan-out graphs — every shape validates clean (the bootstrap
 * property). The spine shape is weighted heavily so the executor-machinery
 * coverage of the existing slices doesn't thin out. */
export function makeArbGraph(
  kinds: readonly NodeKind[] = ["llm", "tool", "routing", "human"],
  opts: ArbGraphOptions = {},
): fc.Arbitrary<Graph> {
  const { structuredOutputs = true, parallel = true } = opts;
  const arms: Array<{ weight: number; arbitrary: fc.Arbitrary<Graph> }> = [
    { weight: 6, arbitrary: arbSpineGraph(kinds) },
  ];
  if (structuredOutputs) arms.push({ weight: 2, arbitrary: arbOutputsGraph });
  if (parallel) arms.push({ weight: 2, arbitrary: arbParallelGraph });
  return arms.length === 1 ? arms[0]!.arbitrary : fc.oneof(...arms);
}

/** Whole-graph arbitrary over all node kinds (the tier-1 slice + bootstrap),
 * including the typed-outputs and `type: parallel` fan-out shapes. */
export const arbGraph: fc.Arbitrary<Graph> = makeArbGraph();

/** Tier-1 slice for `planTransition`: a generated graph paired with one of its
 * non-terminal (llm/tool/human) nodes as the dispatch's `currentNode`. The
 * planner consumes the whole graph (edge selection + goal-gate checks run over
 * it), so the "slice" is `(graph, nodeId)` rather than a detached node. Includes
 * the typed-outputs shape (a plain llm spine) but NOT parallel: the pure planner
 * is never dispatched on a `parallel` node (the executor's fan-out frontier owns
 * it), so feeding it one would test a path that can't occur. */
export const arbGraphWithCurrentNode: fc.Arbitrary<{ graph: Graph; nodeId: string }> = makeArbGraph(undefined, {
  parallel: false,
}).chain((graph) => {
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
  if (body.some((n) => n.attrs.outputs !== undefined)) out.push("has-outputs");
  if (body.some((n) => n.type === "parallel")) out.push("has-parallel");

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
