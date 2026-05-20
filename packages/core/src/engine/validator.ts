// Graph linter. Catches structural and semantic issues before execution.
// See docs/SPEC.md §4.1 (validation phase).

import type { Edge, Graph } from "../types/graph.ts";
import { inputReferences } from "./substitution.ts";

/** Whitelist of known node attribute names — the IR (snake_case) field set
 * the validator runs against, *after* the parser has lowered authoring keys
 * (`thread:` → `thread_id`, `context-files:` →
 * `context_files`, …). Anything outside this set trips W013, surfacing typos
 * and parser passthrough that would otherwise silently no-op. Keep in sync
 * with `NodeAttrs` declared fields in `types/graph.ts`. */
const KNOWN_NODE_ATTRS: ReadonlySet<string> = new Set([
  "label",
  "type",
  "prompt",
  "system_prompt",
  "context_files",
  "skills_disabled",
  "model",
  "provider",
  "summary",
  "thread_id",
  "goal_gate",
  "max_retries",
  "timeout",
  "max_ms",
  "reasoning_effort",
  "allowed_tools",
  "denied_tools",
  "retry_target",
  "fallback_retry_target",
  "tool_command",
  "max_cost_usd",
  "max_tokens",
  "skills",
  "routes",
  "text",
]);

/** Whitelist of known edge attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_EDGE_ATTRS: ReadonlySet<string> = new Set(["label", "thread_id", "outcome", "route"]);

/** Whitelist of known graph attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_GRAPH_ATTRS: ReadonlySet<string> = new Set([
  "goal",
  "label",
  "thread_id",
  "budget_usd",
  "budget_policy",
  "inputs",
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
  const starts = nodes.filter((n) => n.type === "start");
  const exits = nodes.filter((n) => n.type === "exit");

  // E001: start node required
  if (starts.length === 0) {
    diags.push({ severity: "error", code: "E001", message: "graph has no start node (start)" });
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
    diags.push({ severity: "error", code: "E003", message: "graph has no exit node (exit)" });
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
    if (n.type === "start") continue;
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

  // W009: llm (box) node has empty prompt and empty label. The agent
  // boundary substitutes label for prompt when prompt is empty; both
  // empty leaves the LLM call with nothing to do. Catches "I forgot the
  // prompt" authoring mistakes.
  for (const n of nodes) {
    if (n.type !== "llm") continue;
    const promptEmpty = !(typeof n.attrs.prompt === "string" && n.attrs.prompt.trim() !== "");
    const labelEmpty = !(typeof n.attrs.label === "string" && n.attrs.label.trim() !== "");
    if (promptEmpty && labelEmpty) {
      diags.push({
        severity: "warning",
        code: "W009",
        message: `llm node "${n.id}" has empty prompt and empty label — the LLM call will have nothing to do`,
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
    if (n.type === "exit") continue;
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
  // with any type other than `start`.
  for (const n of nodes) {
    if (n.id !== "start") continue;
    if (n.type === "start") continue;
    diags.push({
      severity: "error",
      code: "E029",
      message: `node id "start" is reserved for the synthesized entry node — rename this step`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E030: `${{ inputs.x }}` references an input not declared in the
  // workflow's `inputs:` block. Substitution would silently collapse the
  // placeholder to "" at runtime, so catch the typo / missing declaration
  // at validate-time. Scans the substituted-string attrs (prompt / text /
  // tool_command) on every node.
  {
    const declared = new Set((graph.attrs.inputs ?? []).map((d) => d.name));
    for (const n of nodes) {
      const fields = [n.attrs.prompt, n.attrs.text, n.attrs.tool_command];
      const seen = new Set<string>();
      for (const f of fields) {
        if (typeof f !== "string") continue;
        for (const ref of inputReferences(f)) {
          if (declared.has(ref) || seen.has(ref)) continue;
          seen.add(ref);
          diags.push({
            severity: "error",
            code: "E030",
            message: `node "${n.id}" references undeclared input \`${ref}\` — add it to the inputs: block`,
            nodeId: n.id,
            ...(n.loc !== undefined ? { loc: n.loc } : {}),
          });
        }
      }
    }
  }

  // E009: human node needs ≥1 outgoing edge — otherwise the operator has
  // no choices. Human nodes declare those choices via routes= (for the
  // route-discriminated model) or bare edges; either way an edgeless human
  // node is always a dead end. Catches the construction failure at
  // validate-time so bad workflows never enqueue.
  for (const n of nodes) {
    if (n.type !== "human") continue;
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

  // E008: tool node (tool node) must carry a non-empty `tool_command`.
  // Without it the executor has nothing to spawn and halts at dispatch.
  for (const n of nodes) {
    if (n.type !== "tool") continue;
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
    const target = (graph.attrs as Record<string, unknown>)[key];
    if (typeof target !== "string" || target === "") continue;
    if (!nodeIds.has(target)) {
      diags.push({
        severity: "error",
        code: "E011",
        message: `graph ${key}="${target}" references undefined node`,
      });
    }
  }

  // W007: node with goal_gate=true has no retarget. A goal gate without a
  // retry_target can only halt the run on failure, never recover —
  // almost certainly an authoring oversight.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const hasGateTarget = typeof n.attrs.retry_target === "string" && n.attrs.retry_target !== "";
    if (!hasGateTarget) {
      diags.push({
        severity: "warning",
        code: "W007",
        message: `goal_gate node "${n.id}" has no retry_target — failure can only halt`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E031: a goal gate authored via `retry:` (goal_gate=true AND retry_target
  // set) must declare max_retries — the per-gate retarget cap is co-located
  // with the gate that owns the loop.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const hasGateTarget = typeof n.attrs.retry_target === "string" && n.attrs.retry_target !== "";
    if (!hasGateTarget) continue; // W007 fires; E031 only applies when retry_target IS set
    if (typeof n.attrs.max_retries === "number") continue;
    diags.push({
      severity: "error",
      code: "E031",
      message: `goal-gate step "${n.id}" uses \`retry:\` but has no \`max-retries:\` — add a per-gate retarget cap`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E032: a non-terminal step must declare an explicit success successor.
  // Linear-by-default fall-through was removed — every llm/tool step needs
  // `next:` / `on: {success: …}` / `routes:`, otherwise it dead-ends on
  // success. Terminate a branch by routing to the reserved `exit` sink.
  // Human steps are covered by E009 (no outgoing edges); start/exit are
  // the synthesized source/sink.
  for (const n of nodes) {
    if (n.type !== "llm" && n.type !== "tool") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    // A step has a success path if it has any outgoing edge that can fire on
    // success: an explicit `outcome: success`, a `route`, or a bare
    // unconditional edge. Only a pure `fail` edge leaves success dead-ended.
    const hasSuccessPath = out.some((e) => e.attrs.outcome !== "fail");
    if (!hasSuccessPath) {
      diags.push({
        severity: "error",
        code: "E032",
        message: `step "${n.id}" declares no success successor — add \`next:\`, \`on: {success: …}\`, or \`routes:\` (use \`next: exit\` to finish)`,
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
    if (n.type !== "human") continue;
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

  // E026: text= is a human-node attribute (the prompt shown to the
  // operator). Setting it on a non-human node has no effect at runtime;
  // the diagnostic surfaces the authoring mistake at validate-time.
  for (const n of nodes) {
    if (typeof n.attrs.text !== "string" || n.attrs.text === "") continue;
    if (n.type === "human") continue;
    diags.push({
      severity: "error",
      code: "E026",
      message: `node "${n.id}" sets text= but is not a human node (type="${n.type}") — text= is only meaningful on human nodes`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // W013: unrecognised attribute name. Cast to Record<string, unknown> at
  // the read site so the typed attrs objects remain indexable here without
  // an index signature.
  for (const n of nodes) {
    for (const key of Object.keys(n.attrs as Record<string, unknown>)) {
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
    for (const key of Object.keys(e.attrs as Record<string, unknown>)) {
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
  for (const key of Object.keys(graph.attrs as Record<string, unknown>)) {
    if (KNOWN_GRAPH_ATTRS.has(key)) continue;
    diags.push({
      severity: "warning",
      code: "W013",
      message: `graph has unrecognised attribute "${key}" — typo? (see GraphAttrs for the canonical list)`,
    });
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
