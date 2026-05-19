// Graph linter. Catches structural and semantic issues before execution.
// See docs/SPEC.md §4.1 (validation phase).

import { parseAcceleratorKey } from "../accelerator.ts";
import { type Edge, type Graph, HANDLER_BY_SHAPE, type HandlerType, SHAPE_TO_KIND } from "../types/graph.ts";
import { isRetryPresetName } from "./retry-policy.ts";

/** The handler kinds a `type=` attribute may name. Union of `HANDLER_BY_SHAPE`
 * values — attractor §4.2's registry. Swarm has no extension surface for
 * custom handlers; anything outside this set is a typo (E016). */
const KNOWN_HANDLER_TYPES: ReadonlySet<HandlerType> = new Set(Object.values(HANDLER_BY_SHAPE));

/** Whitelist of known node attribute names. Anything outside this set
 * triggers W013 — surfaces typos like `goalgate=true` and parser passthrough
 * (`NodeAttrs[extra: string]`) that would otherwise silently no-op. The list
 * is the union of `NodeAttrs` declared fields plus bare aliases (`model`,
 * `provider`) that have their own dedicated W011. */
const KNOWN_NODE_ATTRS: ReadonlySet<string> = new Set([
  "label",
  "shape",
  "type",
  "prompt",
  "system_prompt",
  "llm_model",
  "llm_provider",
  "summary",
  "thread_id",
  "goal_gate",
  "max_retries",
  "retry_policy",
  "retry_initial_delay_ms",
  "retry_backoff_factor",
  "retry_max_delay_ms",
  "retry_jitter",
  "timeout",
  "max_ms",
  "idle_timeout",
  "reasoning_effort",
  "allowed_tools",
  "denied_tools",
  "context_files",
  "class",
  "retry_target",
  "fallback_retry_target",
  "tool_command",
  "max_cost_usd",
  "max_tokens",
  "skills",
  "skills_disabled",
  "routes",
  "kind",
  "text",
  "model",
  "provider",
]);

/** Whitelist of known edge attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_EDGE_ATTRS: ReadonlySet<string> = new Set(["label", "thread_id", "loop_restart", "outcome", "route"]);

/** Whitelist of known graph attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_GRAPH_ATTRS: ReadonlySet<string> = new Set([
  "goal",
  "label",
  "thread_id",
  "budget_usd",
  "budget_policy",
  "inputs",
  "max_goal_gate_retries",
]);

const ATTRACTOR_ONLY_EDGE_ATTRS: ReadonlyMap<string, string> = new Map([
  ["loop_restart", "swarm's thread model (thread_id + per-node summary=) supersedes the run-restart use case"],
]);

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** Optional node or edge reference for UI highlighting. */
  nodeId?: string;
  edge?: { from: string; to: string };
  loc?: { line: number; col: number };
}

export interface ValidateOptions {
  /** Treat warnings as errors (useful for CI). */
  strict?: boolean;
}

export class ValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(`graph validation failed: ${diagnostics.length} issues`);
    this.name = "ValidationError";
  }
}

export function validate(graph: Graph, opts: ValidateOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];

  const nodes = Object.values(graph.nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const starts = nodes.filter((n) => n.shape === "Mdiamond");
  const exits = nodes.filter((n) => n.shape === "Msquare");

  // E001: start node required
  if (starts.length === 0) {
    diags.push({ severity: "error", code: "E001", message: "graph has no start node (Mdiamond)" });
  }
  if (starts.length > 1) {
    diags.push({
      severity: "error",
      code: "E002",
      message: `graph has multiple start nodes: ${starts.map((s) => s.id).join(", ")}`,
    });
  }

  // E003: exit node required
  if (exits.length === 0) {
    diags.push({ severity: "error", code: "E003", message: "graph has no exit node (Msquare)" });
  }

  // E004: edge references undefined node
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined source node "${e.from}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
    if (!nodeIds.has(e.to)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined target node "${e.to}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // W001: orphan node (no in-edges, not start)
  const inDegrees = new Map<string, number>();
  for (const n of nodes) inDegrees.set(n.id, 0);
  for (const e of graph.edges) {
    inDegrees.set(e.to, (inDegrees.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.shape === "Mdiamond") continue;
    if ((inDegrees.get(n.id) ?? 0) === 0) {
      diags.push({
        severity: "warning",
        code: "W001",
        message: `node "${n.id}" has no incoming edges (orphan)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W002: unreachable from start
  if (starts.length === 1) {
    const reachable = reachableSet(graph, starts[0]!.id);
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        diags.push({
          severity: "warning",
          code: "W002",
          message: `node "${n.id}" is not reachable from start`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E012: start node must have no incoming edges (attractor §11.2). The
  // start handler is the entry point and is reached by the run-started
  // fact, not by any edge.
  for (const s of starts) {
    if ((inDegrees.get(s.id) ?? 0) > 0) {
      diags.push({
        severity: "error",
        code: "E012",
        message: `start node "${s.id}" must have no incoming edges`,
        nodeId: s.id,
        ...(s.loc !== undefined ? { loc: s.loc } : {}),
      });
    }
  }

  // E013: exit nodes must have no outgoing edges (attractor §11.2).
  for (const e of exits) {
    const out = graph.edges.filter((edge) => edge.from === e.id);
    if (out.length > 0) {
      diags.push({
        severity: "error",
        code: "E013",
        message: `exit node "${e.id}" must have no outgoing edges`,
        nodeId: e.id,
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // W009: codergen (box) node has empty prompt and empty label. The agent
  // boundary substitutes label for prompt when prompt is empty; both
  // empty leaves the LLM call with nothing to do. Catches "I forgot the
  // prompt" authoring mistakes.
  for (const n of nodes) {
    if (n.shape !== "box") continue;
    const promptEmpty = !(typeof n.attrs.prompt === "string" && n.attrs.prompt.trim() !== "");
    const labelEmpty = !(typeof n.attrs.label === "string" && n.attrs.label.trim() !== "");
    if (promptEmpty && labelEmpty) {
      diags.push({
        severity: "warning",
        code: "W009",
        message: `codergen node "${n.id}" has empty prompt and empty label — the LLM call will have nothing to do`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E027: summary= requires thread_id. Summarising nothing makes no sense —
  // fresh nodes have no prior thread to compress. Value-set validation is
  // parser-side via ENUM_KEYS (low|medium|high), so by the time we reach
  // here `summary` is already one of the three valid levels.
  for (const n of nodes) {
    const s = n.attrs.summary;
    if (typeof s === "string" && (s as string) !== "") {
      const hasNodeThread = typeof n.attrs.thread_id === "string" && (n.attrs.thread_id as string) !== "";
      const hasGraphThread = typeof graph.attrs.thread_id === "string" && (graph.attrs.thread_id as string) !== "";
      if (!hasNodeThread && !hasGraphThread) {
        diags.push({
          severity: "error",
          code: "E027",
          message: `node "${n.id}" sets summary="${s}" but has no thread_id — summarising nothing has no effect`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E028: `exit` is reserved as the canonical graceful-halt sink. A node
  // named `exit` must declare `type: exit` — any other type would shadow
  // the reserved name and confuse readers (and a future implicit-sink
  // implementation that bypasses declaration entirely).
  for (const n of nodes) {
    if (n.id !== "exit") continue;
    if (n.shape === "Msquare") continue;
    diags.push({
      severity: "error",
      code: "E028",
      message: `node id "exit" is reserved for the graceful-halt sink — declare it as \`type: exit\` or rename`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E029: `start` is reserved for the synthesized entry node. Authors
  // never declare it; the parser injects it pointing at the first step.
  // Surfaces if a hand-built or tool-generated graph names a step `start`
  // with any non-Mdiamond shape.
  for (const n of nodes) {
    if (n.id !== "start") continue;
    if (n.shape === "Mdiamond") continue;
    diags.push({
      severity: "error",
      code: "E029",
      message: `node id "start" is reserved for the synthesized entry node — rename this step`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E009: human node needs ≥1 outgoing edge — otherwise the operator has
  // no choices. Human nodes declare those choices via routes= (for the
  // route-discriminated model) or bare edges; either way an edgeless human
  // node is always a dead end. Catches the construction failure at
  // validate-time so bad workflows never enqueue.
  for (const n of nodes) {
    if (n.attrs.kind !== "human") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) {
      diags.push({
        severity: "error",
        code: "E009",
        message: `human node "${n.id}" has no outgoing edges and no routes= (operator would have no choices)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E010: hexagon outgoing edges must produce unique accelerator keys.
  // Auto-dispatcher derives keys via parseAcceleratorKey; collisions
  // would shadow each other in the option list (and the handler refuses
  // to construct). Surface at validate-time with the offending labels.
  for (const n of nodes) {
    if (n.shape !== "hexagon") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length < 2) continue;
    const byKey = new Map<string, string[]>();
    for (const e of out) {
      const lbl = typeof e.attrs.label === "string" ? e.attrs.label : e.to;
      const key = parseAcceleratorKey(lbl);
      const list = byKey.get(key) ?? [];
      list.push(lbl);
      byKey.set(key, list);
    }
    for (const [key, labels] of byKey) {
      if (labels.length < 2) continue;
      diags.push({
        severity: "error",
        code: "E010",
        message: `wait.human node "${n.id}" has ${labels.length} edges sharing accelerator key "${key}" (${labels.map((l) => `"${l}"`).join(", ")}) — disambiguate via [A]/[B] prefixes`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E008: tool node (parallelogram) must carry a non-empty `tool_command`.
  // Without it the executor has nothing to spawn and halts at dispatch.
  for (const n of nodes) {
    if (n.shape !== "parallelogram") continue;
    const cmd = n.attrs.tool_command;
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      diags.push({
        severity: "error",
        code: "E008",
        message: `tool node "${n.id}" must define a non-empty \`tool_command\` attribute`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E011: retry_target / fallback_retry_target reference an undefined node.
  // Fires for both node-level (attractor §3.4 step 1/2) and graph-level
  // (steps 3/4) targets. Catches typos that would silently halt the run
  // with `goal_gate_unsatisfied` at the worst possible moment.
  for (const n of nodes) {
    for (const key of ["retry_target", "fallback_retry_target"] as const) {
      const target = n.attrs[key];
      if (typeof target !== "string" || target === "") continue;
      if (!nodeIds.has(target)) {
        diags.push({
          severity: "error",
          code: "E011",
          message: `node "${n.id}" ${key}="${target}" references undefined node`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }
  for (const key of ["retry_target", "fallback_retry_target"] as const) {
    const target = graph.attrs[key];
    if (typeof target !== "string" || target === "") continue;
    if (!nodeIds.has(target)) {
      diags.push({
        severity: "error",
        code: "E011",
        message: `graph ${key}="${target}" references undefined node`,
      });
    }
  }

  // W011: llm node declares bare `model` / `provider` without the `llm_`
  // prefix. The agent backend reads only `llm_model` / `llm_provider`;
  // bare keys are silently dropped and the run falls through to the
  // daemon default. Suppress when the prefixed equivalent is set.
  for (const n of nodes) {
    if (n.shape !== "box") continue;
    const PAIRS: Array<{ bare: "model" | "provider"; prefixed: "llm_model" | "llm_provider" }> = [
      { bare: "model", prefixed: "llm_model" },
      { bare: "provider", prefixed: "llm_provider" },
    ];
    for (const { bare, prefixed } of PAIRS) {
      const bareVal = (n.attrs as Record<string, unknown>)[bare];
      if (typeof bareVal !== "string" || bareVal === "") continue;
      const prefixedVal = (n.attrs as Record<string, unknown>)[prefixed];
      if (typeof prefixedVal === "string" && prefixedVal !== "") continue;
      diags.push({
        severity: "warning",
        code: "W011",
        message: `llm node "${n.id}" declares ${bare}="${bareVal}" but the agent backend only reads \`${prefixed}\` — value is silently ignored. Use \`${prefixed}: ${bareVal}\`.`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W008: retry_policy / default_retry_policy value is not a known preset.
  // Catches typos at validate-time. The runtime falls back to "none"
  // silently otherwise.
  for (const n of nodes) {
    const rp = n.attrs.retry_policy;
    if (typeof rp === "string" && rp !== "" && !isRetryPresetName(rp)) {
      diags.push({
        severity: "warning",
        code: "W008",
        message: `node "${n.id}" retry_policy="${rp}" is not a known preset (none|standard|aggressive|linear|patient)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }
  {
    const drp = graph.attrs.default_retry_policy;
    if (typeof drp === "string" && drp !== "" && !isRetryPresetName(drp)) {
      diags.push({
        severity: "warning",
        code: "W008",
        message: `graph default_retry_policy="${drp}" is not a known preset (none|standard|aggressive|linear|patient)`,
      });
    }
  }

  // W007: node with goal_gate=true has no retarget at any level.
  // The §3.4 retarget chain is gate.retry_target → gate.fallback_retry_target
  // → graph.retry_target → graph.fallback_retry_target → halt. A goal gate
  // with no chain anywhere can only halt the run on failure, never recover —
  // almost certainly an authoring oversight.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const hasGateTarget =
      (typeof n.attrs.retry_target === "string" && n.attrs.retry_target !== "") ||
      (typeof n.attrs.fallback_retry_target === "string" && n.attrs.fallback_retry_target !== "");
    const hasGraphTarget =
      (typeof graph.attrs.retry_target === "string" && graph.attrs.retry_target !== "") ||
      (typeof graph.attrs.fallback_retry_target === "string" && graph.attrs.fallback_retry_target !== "");
    if (!hasGateTarget && !hasGraphTarget) {
      diags.push({
        severity: "warning",
        code: "W007",
        message: `goal_gate node "${n.id}" has no retry_target / fallback_retry_target at gate or graph level — failure can only halt`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W005: duplicate edges (same from/to pair with identical attributes)
  const seen = new Map<string, Edge>();
  for (const e of graph.edges) {
    const key = `${e.from}→${e.to}:${JSON.stringify(e.attrs)}`;
    if (seen.has(key)) {
      diags.push({
        severity: "warning",
        code: "W005",
        message: `duplicate edge "${e.from}" → "${e.to}" with identical attributes`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    } else {
      seen.set(key, e);
    }
  }

  // W006: cycles without an exit reachable from the cycle
  const exitIds = new Set(exits.map((e) => e.id));
  for (const sccNodes of stronglyConnectedComponents(graph)) {
    if (sccNodes.length < 2 && !hasSelfLoop(graph, sccNodes[0]!)) continue; // not a cycle
    const reachable = reachableFromSet(graph, sccNodes);
    const hasExit = [...reachable].some((id) => exitIds.has(id));
    if (!hasExit) {
      diags.push({
        severity: "error",
        code: "E006",
        message: `cycle ${sccNodes.join(" → ")} has no reachable exit node`,
      });
    }
  }

  // E016: node `type=` names a handler outside the known set (attractor
  // §4.2 registry, swarm has no extension surface). Silent fall-through
  // to the shape would mask typos like `type="codrgen"`; error so the
  // workflow fails at validate-time.
  //
  // E017–E026 follow: routing + human-node structural rules introduced
  // by docs/proposals/llm-routing.md Phase 5.
  for (const n of nodes) {
    const t = n.attrs.type;
    if (typeof t !== "string" || t === "") continue;
    if (!(KNOWN_HANDLER_TYPES as ReadonlySet<string>).has(t)) {
      diags.push({
        severity: "error",
        code: "E016",
        message: `node "${n.id}" type="${t}" is not a known handler (${[...KNOWN_HANDLER_TYPES].join(", ")})`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E017: routing node (non-empty routes=) must not have outgoing edges
  // keyed by outcome=. Routing nodes discriminate by route=; mixing the
  // two discriminators on the same source node is always ambiguous.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    for (const e of graph.edges) {
      if (e.from !== n.id) continue;
      if (typeof e.attrs.outcome !== "string") continue;
      diags.push({
        severity: "error",
        code: "E017",
        message: `routing node "${n.id}" has edge "${e.from}" → "${e.to}" with outcome="${e.attrs.outcome}" — routing nodes discriminate by route=, not outcome=`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E018: a single edge must not carry both outcome= and route=. An edge
  // is discriminated by exactly one of the two; both together is
  // always a model error.
  for (const e of graph.edges) {
    const hasOutcome = typeof e.attrs.outcome === "string";
    const hasRoute = typeof e.attrs.route === "string" && e.attrs.route !== "";
    if (hasOutcome && hasRoute) {
      diags.push({
        severity: "error",
        code: "E018",
        message: `edge "${e.from}" → "${e.to}" sets both outcome="${e.attrs.outcome}" and route="${e.attrs.route}" — use exactly one discriminator`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E019: edge with route= must reference a value that the source node
  // declares in routes=. Route values not declared at the source node
  // can never be selected and indicate an authoring mistake (typo or
  // stale edge after a routes= edit).
  for (const e of graph.edges) {
    const edgeRoute = e.attrs.route;
    if (typeof edgeRoute !== "string" || edgeRoute === "") continue;
    const src = graph.nodes[e.from];
    if (src === undefined) continue; // E004 already fired
    const declared = Array.isArray(src.attrs.routes) ? src.attrs.routes : [];
    if (declared.length === 0) {
      diags.push({
        severity: "error",
        code: "E019",
        message: `edge "${e.from}" → "${e.to}" has route="${edgeRoute}" but source node "${e.from}" declares no routes=`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    } else if (!declared.includes(edgeRoute)) {
      diags.push({
        severity: "error",
        code: "E019",
        message: `edge "${e.from}" → "${e.to}" has route="${edgeRoute}" but source node "${e.from}" only declares routes="${declared.join(",")}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E020: every outgoing edge from a routing node must carry exactly one
  // of route= or outcome=. An unannotated edge from a routing node
  // would be selected by an unrelated discriminator (or never), making
  // the intent of the edge ambiguous.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    for (const e of graph.edges) {
      if (e.from !== n.id) continue;
      const hasOutcome = typeof e.attrs.outcome === "string";
      const hasRoute = typeof e.attrs.route === "string" && e.attrs.route !== "";
      if (!hasOutcome && !hasRoute) {
        diags.push({
          severity: "error",
          code: "E020",
          message: `routing node "${n.id}" has edge "${e.from}" → "${e.to}" with neither route= nor outcome= — every edge from a routing node must be annotated`,
          edge: { from: e.from, to: e.to },
          ...(e.loc !== undefined ? { loc: e.loc } : {}),
        });
      }
    }
  }

  // E021: every value declared in routes= must have a matching outgoing
  // edge with route=<value>. Undischarged routes can never be taken;
  // they represent a missing edge or a renamed route value.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    const coveredRoutes = new Set(
      graph.edges.filter((e) => e.from === n.id && typeof e.attrs.route === "string").map((e) => e.attrs.route),
    );
    for (const r of routes) {
      if (!coveredRoutes.has(r)) {
        diags.push({
          severity: "error",
          code: "E021",
          message: `routing node "${n.id}" declares route "${r}" in routes= but no outgoing edge has route="${r}"`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E022: human nodes must declare routes= so the operator has a defined
  // set of choices. A human node with no routes= has no structured
  // vocabulary for operator dispatch.
  for (const n of nodes) {
    if (n.attrs.kind !== "human") continue;
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) {
      diags.push({
        severity: "error",
        code: "E022",
        message: `human node "${n.id}" has no routes= declaration — operator needs at least one named route`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E023: goal_gate and routes= are mutually exclusive. A goal gate
  // is a binary pass/fail evaluation; routing is LLM-directed
  // multi-branch selection. Combining them would make the node's exit
  // semantics undefined.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length > 0) {
      diags.push({
        severity: "error",
        code: "E023",
        message: `node "${n.id}" combines goal_gate=true with routes= — these are mutually exclusive exit strategies`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E024: duplicate discriminator values from the same source node.
  // Two edges sharing the same outcome= or the same route= from a
  // single source are ambiguous: the engine cannot decide which to
  // take, and one of the edges is permanently shadowed.
  {
    const sourceEdges = new Map<string, typeof graph.edges>();
    for (const e of graph.edges) {
      const list = sourceEdges.get(e.from) ?? [];
      list.push(e);
      sourceEdges.set(e.from, list);
    }
    for (const [fromId, edges] of sourceEdges) {
      const outcomeCounts = new Map<string, number>();
      const routeCounts = new Map<string, number>();
      for (const e of edges) {
        if (typeof e.attrs.outcome === "string") {
          outcomeCounts.set(e.attrs.outcome, (outcomeCounts.get(e.attrs.outcome) ?? 0) + 1);
        }
        if (typeof e.attrs.route === "string" && e.attrs.route !== "") {
          routeCounts.set(e.attrs.route, (routeCounts.get(e.attrs.route) ?? 0) + 1);
        }
      }
      for (const [val, count] of outcomeCounts) {
        if (count < 2) continue;
        diags.push({
          severity: "error",
          code: "E024",
          message: `node "${fromId}" has ${count} edges with outcome="${val}" — each outcome= value must appear at most once per source`,
          nodeId: fromId,
        });
      }
      for (const [val, count] of routeCounts) {
        if (count < 2) continue;
        diags.push({
          severity: "error",
          code: "E024",
          message: `node "${fromId}" has ${count} edges with route="${val}" — each route= value must appear at most once per source`,
          nodeId: fromId,
        });
      }
    }
  }

  // E025: explicit kind= contradicts the shape's canonical kind via
  // SHAPE_TO_KIND. When the parser auto-derives kind from shape, the two
  // are always consistent (kind left undefined → derived). A contradiction
  // only arises when the author writes an explicit kind= that disagrees
  // with the shape — e.g. kind=codergen shape=hexagon. The shape=hexagon
  // with kind=human alias is explicitly valid (same mapping).
  for (const n of nodes) {
    const explicitKind = n.attrs.kind;
    if (typeof explicitKind !== "string") continue;
    const shapeKind = SHAPE_TO_KIND[n.shape as keyof typeof SHAPE_TO_KIND];
    if (shapeKind === undefined) continue; // start/exit shapes have no kind mapping
    if (shapeKind !== explicitKind) {
      diags.push({
        severity: "error",
        code: "E025",
        message: `node "${n.id}" has kind="${explicitKind}" but shape="${n.shape}" maps to kind="${shapeKind}" via SHAPE_TO_KIND — align kind= with the shape or change the shape`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E026: text= is a human-node attribute (the prompt shown to the
  // operator). Setting it on a non-human node has no effect at runtime;
  // the diagnostic surfaces the authoring mistake at validate-time.
  for (const n of nodes) {
    if (typeof n.attrs.text !== "string" || n.attrs.text === "") continue;
    if (n.attrs.kind === "human") continue;
    diags.push({
      severity: "error",
      code: "E026",
      message: `node "${n.id}" sets text= but is not a human node (kind="${n.attrs.kind ?? "codergen"}") — text= is only meaningful on human nodes`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // W012: node's `type=` resolves to a different handler than its shape.
  // `type` wins at dispatch (attractor §2.6 + §4.2); the warning flags
  // the visual/runtime divergence so authors notice they're overriding
  // the shape's natural mapping. Suppressed when type matches the shape's
  // canonical handler (the redundant-explicit case is harmless).
  // NOTE: the legacy W004 rule (context.hitl.* edge condition warning) was
  // removed here — routing is now discriminated by route= and routes=,
  // not by condition patterns on hexagon edges.
  for (const n of nodes) {
    const t = n.attrs.type;
    if (typeof t !== "string" || t === "") continue;
    if (!(KNOWN_HANDLER_TYPES as ReadonlySet<string>).has(t)) continue; // E016 already fired
    const shapeKind = HANDLER_BY_SHAPE[n.shape];
    if (shapeKind !== t) {
      diags.push({
        severity: "warning",
        code: "W012",
        message: `node "${n.id}" shape="${n.shape}" resolves to "${shapeKind}" but type="${t}" overrides — using "${t}". Align the shape or drop type= to suppress.`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W013: unrecognised attribute name. Parser passthrough (NodeAttrs /
  // EdgeAttrs / GraphAttrs index signatures) accepts anything; this lint
  // catches typos at validate-time. Authors who genuinely need a custom
  // attribute can either extend the whitelist or accept the warning.
  for (const n of nodes) {
    for (const key of Object.keys(n.attrs)) {
      if (KNOWN_NODE_ATTRS.has(key)) continue;
      diags.push({
        severity: "warning",
        code: "W013",
        message: `node "${n.id}" has unrecognised attribute "${key}" — typo? (see packages/core/src/types/graph.ts NodeAttrs for the canonical list)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }
  for (const e of graph.edges) {
    for (const key of Object.keys(e.attrs)) {
      if (KNOWN_EDGE_ATTRS.has(key)) continue;
      diags.push({
        severity: "warning",
        code: "W013",
        message: `edge "${e.from}" → "${e.to}" has unrecognised attribute "${key}" — typo? (see EdgeAttrs for the canonical list)`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }
  for (const key of Object.keys(graph.attrs)) {
    if (KNOWN_GRAPH_ATTRS.has(key)) continue;
    diags.push({
      severity: "warning",
      code: "W013",
      message: `graph has unrecognised attribute "${key}" — typo? (see GraphAttrs for the canonical list)`,
    });
  }

  // W014: attractor edge attribute that swarm's architecture makes inert
  // (`loop_restart`). Documented in attractor but the swarm runtime has
  // no path that consults it; see SPEC.md §5 for rationale.
  for (const e of graph.edges) {
    for (const [key, why] of ATTRACTOR_ONLY_EDGE_ATTRS) {
      if (e.attrs[key] === undefined) continue;
      diags.push({
        severity: "warning",
        code: "W014",
        message: `edge "${e.from}" → "${e.to}" sets ${key}= but swarm does not honor it (${why}); see SPEC.md §5`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  if (opts.strict) {
    return diags.map((d) => (d.severity === "warning" ? { ...d, severity: "error" as const } : d));
  }
  return diags;
}

/** Throw if any `error`-severity diagnostics exist. */
export function validateOrThrow(graph: Graph, opts: ValidateOptions = {}): void {
  const diags = validate(graph, opts);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new ValidationError(diags);
}

function reachableSet(graph: Graph, startId: string): Set<string> {
  return reachableFromSet(graph, [startId]);
}

function reachableFromSet(graph: Graph, startIds: string[]): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of graph.edges) {
      if (e.from === id && !visited.has(e.to)) stack.push(e.to);
    }
  }
  return visited;
}

function hasSelfLoop(graph: Graph, nodeId: string): boolean {
  return graph.edges.some((e) => e.from === nodeId && e.to === nodeId);
}

/** Tarjan's algorithm for strongly connected components. */
function stronglyConnectedComponents(graph: Graph): string[][] {
  const nodes = Object.keys(graph.nodes);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const out: string[][] = [];

  const neighbors = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);

  function strongConnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of neighbors(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  }

  for (const v of nodes) if (!index.has(v)) strongConnect(v);
  return out;
}
