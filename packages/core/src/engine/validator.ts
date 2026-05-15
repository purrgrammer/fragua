// Graph linter. Catches structural and semantic issues before execution.
// See docs/SPEC.md §4.1 (validation phase).

import { parseAcceleratorKey } from "../accelerator.ts";
import { type Edge, type Graph, HANDLER_BY_SHAPE, type HandlerType } from "../types/graph.ts";
import { parseCondition } from "./condition.ts";
import { discoverFanInTarget, validateBranchSubgraphs } from "./parallel-discovery.ts";
import { isRetryPresetName } from "./retry-policy.ts";
import { parseStylesheet, StylesheetParseError, selectorMatches } from "./stylesheet.ts";

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
  "fidelity",
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
  "context",
  "allowed_tools",
  "denied_tools",
  "context_files",
  "class",
  "retry_target",
  "fallback_retry_target",
  "auto_status",
  "allow_partial",
  "join_policy",
  "tool_command",
  "max_cost_usd",
  "max_tokens",
  "skills",
  "skills_disabled",
  "model",
  "provider",
]);

/** Whitelist of known edge attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_EDGE_ATTRS: ReadonlySet<string> = new Set([
  "label",
  "condition",
  "weight",
  "fidelity",
  "thread_id",
  "loop_restart",
]);

/** Whitelist of known graph attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_GRAPH_ATTRS: ReadonlySet<string> = new Set([
  "goal",
  "label",
  "default_fidelity",
  "default_max_retries",
  "default_max_retry", // attractor §2.5 legacy alias
  "default_retry_policy",
  "retry_target",
  "fallback_retry_target",
  "max_goal_gate_retries",
  "model_stylesheet",
  "thread_id",
  "budget_usd",
  "budget_tokens",
  "budget_policy",
]);

/** Attributes attractor defines but swarm's architecture makes meaningless.
 * Authors who set them get W014 with a pointer to SPEC.md §5 — better
 * than the previous silent no-op. */
const ATTRACTOR_ONLY_NODE_ATTRS: ReadonlyMap<string, string> = new Map([
  ["auto_status", "swarm handlers return typed HandlerResult directly — there is no missing-status path to synthesize"],
]);

const ATTRACTOR_ONLY_EDGE_ATTRS: ReadonlyMap<string, string> = new Map([
  ["loop_restart", "swarm's fidelity model (per-edge truncate/compact/summary) supersedes the run-restart use case"],
]);

function isEmptyCondition(cond: string | undefined): boolean {
  return !cond || cond.trim() === "";
}

const NODE_OUTPUT_RE = /\$([A-Za-z_][A-Za-z0-9_-]*)\.output(?:\.|\b)/g;

function collectReferences(template: string): { nodeIds: string[] } {
  const nodeIds: string[] = [];
  for (const m of template.matchAll(NODE_OUTPUT_RE)) {
    const id = m[1];
    if (id && !nodeIds.includes(id)) nodeIds.push(id);
  }
  return { nodeIds };
}

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

  // W003: no fail-edge (or unconditional fallback) from codergen/tool nodes
  // with only conditional edges. A run can silently terminate otherwise.
  // Skip diamond (conditional) and Msquare/Mdiamond — diamond's no-op
  // handler structurally cannot return fail (attractor §4.7), and the
  // start/exit shapes have their own structure rules.
  for (const n of nodes) {
    if (n.shape === "Mdiamond" || n.shape === "Msquare") continue;
    if (n.shape === "diamond") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) continue; // terminal behaviour ok; engine handles
    const anyUnconditional = out.some((e) => isEmptyCondition(e.attrs.condition));
    const anyFailCondition = out.some((e) => (e.attrs.condition ?? "").includes("outcome=fail"));
    if (!anyUnconditional && !anyFailCondition) {
      diags.push({
        severity: "warning",
        code: "W003",
        message: `node "${n.id}" has only conditional edges and no "outcome=fail" catch-all; run may silently terminate on failure`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
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

  // E014: condition syntax — every edge `condition` parses cleanly.
  // Surfaces author typos at validate-time instead of edge-selection
  // failures mid-run.
  for (const e of graph.edges) {
    const cond = e.attrs.condition;
    if (typeof cond !== "string" || cond.trim() === "") continue;
    try {
      parseCondition(cond);
    } catch (err) {
      diags.push({
        severity: "error",
        code: "E014",
        message: `edge "${e.from}" → "${e.to}" condition="${cond}" failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
        edge: { from: e.from, to: e.to },
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

  // W010: fidelity value not recognised. Falls back to "compact" at
  // runtime; W010 surfaces typos like "compcat".
  const VALID_FIDELITY = new Set(["full", "truncate", "compact", "summary:low", "summary:medium", "summary:high"]);
  for (const n of nodes) {
    const f = n.attrs.fidelity;
    if (typeof f === "string" && (f as string) !== "" && !VALID_FIDELITY.has(f as string)) {
      diags.push({
        severity: "warning",
        code: "W010",
        message: `node "${n.id}" fidelity="${f}" is not a known mode (full|truncate|compact|summary:low|summary:medium|summary:high)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }
  {
    const df = graph.attrs.default_fidelity;
    if (typeof df === "string" && (df as string) !== "" && !VALID_FIDELITY.has(df as string)) {
      diags.push({
        severity: "warning",
        code: "W010",
        message: `graph default_fidelity="${df}" is not a known mode`,
      });
    }
  }

  // W004: unresolved $nodeId.output references
  for (const n of nodes) {
    const prompt = n.attrs.prompt;
    if (typeof prompt !== "string") continue;
    const refs = collectReferences(prompt);
    for (const id of refs.nodeIds) {
      if (!nodeIds.has(id)) {
        diags.push({
          severity: "error",
          code: "E005",
          message: `node "${n.id}" references unknown node "$${id}.output"`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E007: parallel node (component) must have branches that converge on
  // a single tripleoctagon (parallel.fan_in). Per attractor §4.8 the
  // fan-in target is discovered structurally via edges, not declared.
  for (const n of nodes) {
    if (n.shape !== "component") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) {
      diags.push({
        severity: "error",
        code: "E007",
        message: `parallel node "${n.id}" has no outgoing branches`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
      continue;
    }
    const discovery = discoverFanInTarget(graph, n.id);
    if (discovery.kind === "no-fan-in") {
      diags.push({
        severity: "error",
        code: "E007",
        message: `parallel "${n.id}" has no reachable tripleoctagon (parallel.fan_in) from any branch`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    } else if (discovery.kind === "ambiguous-fan-in") {
      diags.push({
        severity: "error",
        code: "E007",
        message: `parallel "${n.id}" has multiple tripleoctagons reachable from all branches: ${discovery.candidates.join(", ")} (must be exactly one)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    } else if (discovery.kind === "branches-diverge") {
      diags.push({
        severity: "error",
        code: "E007",
        message: `parallel "${n.id}" branches converge on different tripleoctagons; ensure all branches reach the same fan-in node`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E009: hexagon (wait.human) needs ≥1 outgoing edge — otherwise the
  // operator has no choices to pick. Catches the same construction
  // failure auto-dispatcher flags at runtime, but at validate-time so
  // bad workflows never enqueue.
  for (const n of nodes) {
    if (n.shape !== "hexagon") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) {
      diags.push({
        severity: "error",
        code: "E009",
        message: `wait.human node "${n.id}" has no outgoing edges (operator would have no choices)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W004: hexagon outgoing edge carries a legacy `context.hitl.*`
  // condition. The pre-structured-HITL handler wrote operator input to
  // `routing["hitl.<nodeId>"]` so workflows could branch on it via
  // edge conditions. The structured handler writes
  // `human.gate.{selected,label,note}` and routes via `suggestedNextIds`;
  // the legacy condition will never match and the edge is dead code.
  // Authors should drop the condition and rely on the `[K] Label`
  // accelerator on the edge to drive routing.
  for (const n of nodes) {
    if (n.shape !== "hexagon") continue;
    for (const e of graph.edges) {
      if (e.from !== n.id) continue;
      const cond = e.attrs.condition;
      if (typeof cond !== "string") continue;
      if (!/\bcontext\.hitl\b/.test(cond)) continue;
      diags.push({
        severity: "warning",
        code: "W004",
        message: `wait.human edge "${e.from}" → "${e.to}" uses a legacy "context.hitl.*" condition that the structured HITL handler never writes (use "[K] Label" on the edge instead)`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
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

  // E015: model_stylesheet syntax (attractor §8). Surfaces parse errors
  // at validate-time so authors see them at upload, not run.
  {
    const src = graph.attrs.model_stylesheet;
    if (typeof src === "string" && src.trim() !== "") {
      try {
        parseStylesheet(src);
      } catch (err) {
        const detail =
          err instanceof StylesheetParseError ? err.message : err instanceof Error ? err.message : String(err);
        diags.push({
          severity: "error",
          code: "E015",
          message: `graph model_stylesheet failed to parse: ${detail}`,
        });
      }
    }
  }

  // W011: codergen (box) node declares bare `model` / `provider` without
  // the `llm_` prefix. The agent backend reads only `llm_model` /
  // `llm_provider`; bare keys are silently dropped and the run falls
  // through to the daemon default. Suppress the warning when the
  // prefixed equivalent is set OR a graph `model_stylesheet` rule
  // matches the node and supplies that property — both cases mean the
  // backend will see a value.
  {
    let stylesheetRules: ReturnType<typeof parseStylesheet> = [];
    const ssSrc = graph.attrs.model_stylesheet;
    if (typeof ssSrc === "string" && ssSrc.trim() !== "") {
      try {
        stylesheetRules = parseStylesheet(ssSrc);
      } catch {
        // E015 already reports parse errors; treat as no coverage here.
      }
    }
    const stylesheetCovers = (node: (typeof nodes)[number], prop: "llm_model" | "llm_provider"): boolean => {
      for (const rule of stylesheetRules) {
        if (rule.decls[prop] !== undefined && selectorMatches(rule.selector, node)) return true;
      }
      return false;
    };
    const PAIRS: Array<{ bare: "model" | "provider"; prefixed: "llm_model" | "llm_provider" }> = [
      { bare: "model", prefixed: "llm_model" },
      { bare: "provider", prefixed: "llm_provider" },
    ];
    for (const n of nodes) {
      if (n.shape !== "box") continue;
      for (const { bare, prefixed } of PAIRS) {
        const bareVal = (n.attrs as Record<string, unknown>)[bare];
        if (typeof bareVal !== "string" || bareVal === "") continue;
        const prefixedVal = (n.attrs as Record<string, unknown>)[prefixed];
        if (typeof prefixedVal === "string" && prefixedVal !== "") continue;
        if (stylesheetCovers(n, prefixed)) continue;
        diags.push({
          severity: "warning",
          code: "W011",
          message: `codergen node "${n.id}" declares ${bare}="${bareVal}" but the agent backend only reads \`${prefixed}\` — value is silently ignored. Use \`${prefixed} = "${bareVal}"\` or a graph \`model_stylesheet = "* { ${prefixed}: ${bareVal}; }"\` rule.`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
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

  // W012: node's `type=` resolves to a different handler than its shape.
  // `type` wins at dispatch (attractor §2.6 + §4.2); the warning flags
  // the visual/runtime divergence so authors notice they're overriding
  // the shape's natural mapping. Suppressed when type matches the shape's
  // canonical handler (the redundant-explicit case is harmless).
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

  // W014: attractor attribute that swarm's architecture makes inert.
  // `auto_status` (node) and `loop_restart` (edge) are documented in
  // attractor but the swarm runtime has no path that consults them; see
  // SPEC.md §5 for rationale. The whitelist (W013) accepts them so
  // they don't double-warn — this lint is their dedicated signal.
  for (const n of nodes) {
    for (const [key, why] of ATTRACTOR_ONLY_NODE_ATTRS) {
      if (n.attrs[key] === undefined) continue;
      diags.push({
        severity: "warning",
        code: "W014",
        message: `node "${n.id}" sets ${key}= but swarm does not honor it (${why}); see SPEC.md §5`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }
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

  // W017: parallel branch subgraph well-formedness (P3.1 / P3.3 of
  // docs/proposals/parallel.md). Each `component` node's branch
  // subgraph — the slice from its outgoing edges to the converging
  // tripleoctagon — must be a tree-of-DAGs: every node reachable from
  // a branch root belongs to that branch alone (no cross-branch edges
  // share ownership of an interior node). Cycles inside a branch are
  // tolerated only via the same `max_retries`/`retry_target`
  // mechanisms top-level workflows use; we still surface them so
  // authors know the subgraph isn't a pure DAG.
  for (const n of nodes) {
    if (n.shape !== "component") continue;
    const discovery = discoverFanInTarget(graph, n.id);
    if (discovery.kind !== "ok") continue;
    const report = validateBranchSubgraphs(graph, discovery.branches, discovery.fanInNode);
    for (const finding of report.findings) {
      if (finding.kind === "cross-branch") {
        diags.push({
          severity: "warning",
          code: "W017",
          message: `node "${finding.nodeId}" is reachable from multiple branches of parallel "${n.id}" (${finding.branchRoots.join(", ")}). The executor's per-sub-run subgraph slice can't decide which sub-run owns it — split the node or restructure so each branch's subgraph is disjoint.`,
          nodeId: finding.nodeId,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      } else if (finding.kind === "cycle") {
        diags.push({
          severity: "info",
          code: "W017",
          message: `branch subgraph rooted at "${finding.branchRoot}" contains a cycle through "${finding.nodeId}". Allowed only if guarded by max_retries / retry_target on the backward edge — see SPEC §3.6.`,
          nodeId: finding.nodeId,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // W015: tripleoctagon (parallel.fan_in) node has `prompt=` set. fan_in
  // is structural-only — a deterministic heuristic ranker — so `prompt=`
  // is parsed but never read by the handler. The fix is one of two
  // patterns: (a) downstream codergen node referencing `$<branchId>.output`
  // for cross-branch synthesis (see review.dot); (b) `agent` tool in an
  // upstream codergen for runtime-decided fan-out (see orchestrate.dot).
  for (const n of nodes) {
    if (n.shape !== "tripleoctagon") continue;
    const p = n.attrs.prompt;
    if (typeof p !== "string" || p.trim() === "") continue;
    diags.push({
      severity: "warning",
      code: "W015",
      message: `tripleoctagon (parallel.fan_in) node "${n.id}" has prompt= set but fan_in runs a deterministic heuristic ranker — the prompt is never read. For LLM synthesis of branch outputs, add a downstream codergen referencing $<branchId>.output (see review.dot), or fan out via the agent tool inside an upstream codergen (see orchestrate.dot).`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
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
