// Graph model: Nodes, Edges, and the Graph itself. See docs/SPEC.md §3.1.

import type { FidelityMode } from "./fidelity.ts";

/** Attractor node shapes, each mapping to a handler. The canonical 8 from
 * attractor-spec §2.8. `loop` and `stack.manager_loop` are intentionally
 * absent — loops are backward conditional edges bounded by `max_retries`
 * on the target node (§3.6 / §5.2). */
export type NodeShape =
  | "Mdiamond" // start
  | "Msquare" // exit
  | "box" // codergen (default)
  | "diamond" // conditional
  | "hexagon" // wait.human
  | "component" // parallel
  | "tripleoctagon" // parallel.fan_in
  | "parallelogram"; // tool

export const HANDLER_BY_SHAPE = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  diamond: "conditional",
  hexagon: "wait.human",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
} as const satisfies Record<NodeShape, string>;

export type HandlerType = (typeof HANDLER_BY_SHAPE)[NodeShape];

export type ContextMode = "fresh" | "shared";

/** Attribute values that survive DOT parsing + coercion. */
type AttrScalar = string | number | boolean | string[];

export interface NodeAttrs {
  label?: string;
  shape?: NodeShape;
  type?: string;
  prompt?: string;
  /** Per-node system-prompt override. When set, replaces the backend's
   * global system prompt for this call — the context_files block is
   * still prepended. Use for reviewer / planner subagents that need a
   * different persona than the rest of the workflow. */
  system_prompt?: string;
  /** Provider-native LLM model id (attractor §2.6). Examples:
   * `claude-opus-4-7`, `gpt-5.2`. */
  llm_model?: string;
  /** Provider key (attractor §2.6). E.g. `anthropic`, `openai`. */
  llm_provider?: string;
  fidelity?: FidelityMode;
  thread_id?: string;
  goal_gate?: boolean;
  max_retries?: number;
  /** Named retry preset (attractor §3.6). One of "none" | "standard" |
   * "aggressive" | "linear" | "patient". Falls back to graph
   * `default_retry_policy`, then "none". The preset's maxAttempts maps
   * to max_retries via max_retries = max_attempts - 1; an explicit
   * `max_retries` on the node overrides the preset's count. */
  retry_policy?: string;
  /** Custom backoff overrides (attractor §3.6). When any of these is set,
   * the resolved BackoffConfig uses the custom value in place of the
   * preset's. */
  retry_initial_delay_ms?: number;
  retry_backoff_factor?: number;
  retry_max_delay_ms?: number;
  retry_jitter?: boolean;
  /** Per-node hard timeout. Duration-string form (e.g. "30s", "5m", "2h")
   * is parsed via `parseDurationMs`. Wins over `.swarm/config.jsonc`
   * `timeouts.<kind>` and the handler's built-in default. */
  timeout?: string;
  /** Per-node hard timeout in raw milliseconds. Same precedence as
   * `timeout` — either may be set, not both. */
  max_ms?: number;
  idle_timeout?: number;
  reasoning_effort?: "low" | "medium" | "high";
  context?: ContextMode;
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Files read from the target project root and prepended to the agent's
   * system prompt as `<project-conventions>` blocks. Comma-separated in DOT. */
  context_files?: string[];
  class?: string;
  retry_target?: string;
  fallback_retry_target?: string;
  auto_status?: boolean;
  allow_partial?: boolean;
  /** Parallel-node config (component shape). Per attractor §4.8 the
   * fan-in target is discovered structurally via edges (the converging
   * tripleoctagon), not declared as an attribute — see
   * `engine/parallel-discovery.ts`. */
  join_policy?: "wait_all" | "first_success";
  /** Tool-node config (parallelogram shape). Shell command executed by
   * the tool handler. Substitution is applied: $ARGUMENTS,
   * $nodeId.output[.path], ${context.*}. */
  tool_command?: string;
  /** Per-node cumulative cost ceiling in USD. Cumulative across all
   * iterations of this node within the run. When crossed at a turn
   * boundary, `budget.stop` fires and one of three things happens:
   * `"pause"` (default) emits `fact.run_paused{reason:"budget"}` and
   * waits for `intent.budget_adjusted` + `intent.resume`; `"stop"`
   * halts with `reason:"budget"`; `"warn"` keeps firing the events
   * but never halts/pauses. Soft `budget.warn` fires once per run
   * when cumulative reaches 80 % of the ceiling. */
  max_cost_usd?: number;
  /** Per-node cumulative token ceiling (across input + output + cache).
   * Same enforcement shape as `max_cost_usd`. */
  max_tokens?: number;
  /** Scope the skills catalog visible to this node. Unset = all discovered
   * skills. Set = only these names appear in the `<available_skills>`
   * block of the system prompt. Comma-separated in DOT. Agents read
   * SKILL.md bodies directly via the `read` tool; there is no dedicated
   * load-skill tool under the trimmed agent surface. */
  skills?: string[];
  /** Hard opt-out — no skills catalog in the system prompt for this node. */
  skills_disabled?: boolean;
  /** Opaque JSON Schema string the codergen `emit_output` tool validates
   *  emitted data against via `Value.Check` from `@sinclair/typebox/value`.
   *  When set, the node MUST call `emit_output` with conforming data
   *  or the outcome is downgraded to `fail`. Parsed at workflow
   *  registration; malformed JSON / non-schema-shaped values surface
   *  as E017. See docs/proposals/codergen-context-output-tools.md §3. */
  output_schema?: string;
  [extra: string]: AttrScalar | undefined;
}

export interface EdgeAttrs {
  label?: string;
  condition?: string;
  weight?: number;
  fidelity?: FidelityMode;
  thread_id?: string;
  [extra: string]: AttrScalar | undefined;
}

export interface GraphAttrs {
  goal?: string;
  label?: string;
  default_fidelity?: FidelityMode;
  default_max_retries?: number;
  /** Default retry preset for nodes that omit `retry_policy`. Falls back
   * to "none" when unset. */
  default_retry_policy?: string;
  retry_target?: string;
  fallback_retry_target?: string;
  /** Cap how many times a failing goal gate routes back to `retry_target`.
   * Default 3. Prevents runaway retry loops when the retry target itself
   * keeps failing for the same reason. */
  max_goal_gate_retries?: number;
  model_stylesheet?: string;
  thread_id?: string;
  /** Per-run cost ceiling in USD. Once the run's cumulative cost crosses
   * this, `budget.stop` fires and the run pauses (default), halts, or
   * just warns — see `budget_policy`. Soft `budget.warn` at 80 % of the
   * ceiling, once per run. */
  budget_usd?: number;
  /** Per-run total-token ceiling (input + output + cache). Same
   * enforcement shape as `budget_usd`. */
  budget_tokens?: number;
  /** Policy when a budget threshold is crossed:
   * - `"pause"` (default): emit `fact.run_paused{reason:"budget"}` and
   *   wait for the operator to raise the cap (`intent.budget_adjusted`)
   *   and `intent.resume`. The run's accumulated work is preserved.
   * - `"stop"`: hard-fail the run on first breach with
   *   `fact.run_halted{reason:"budget"}`. Use for CI gates that must
   *   never overspend.
   * - `"warn"`: keep firing `budget.warn` / `budget.stop` events but
   *   never halt or pause. */
  budget_policy?: "warn" | "stop" | "pause";
  [extra: string]: AttrScalar | undefined;
}

export interface Location {
  line: number;
  col: number;
}

export interface Node {
  id: string;
  shape: NodeShape;
  attrs: NodeAttrs;
  /** Class list derived from subgraph membership + explicit `class` attr. */
  classes: string[];
  /** Location in source for error reporting (1-indexed line/column). */
  loc?: Location;
}

export interface Edge {
  from: string;
  to: string;
  attrs: EdgeAttrs;
  loc?: Location;
}

export interface Subgraph {
  id: string;
  label?: string;
  /** CSS-like class derived from the label (e.g. `label="Loop A"` → `loop-a`). */
  derived_class?: string;
  node_ids: string[];
  node_defaults: NodeAttrs;
}

export interface Graph {
  id: string;
  /** "digraph" is the only supported graph kind. */
  directed: true;
  attrs: GraphAttrs;
  nodes: Record<string, Node>;
  edges: Edge[];
  subgraphs: Subgraph[];
}

const KNOWN_HANDLER_TYPES: ReadonlySet<HandlerType> = new Set(Object.values(HANDLER_BY_SHAPE));

function isHandlerType(s: string): s is HandlerType {
  return (KNOWN_HANDLER_TYPES as ReadonlySet<string>).has(s);
}

/** Resolve a node's handler. `type=` takes precedence over shape-based
 * resolution when it names a known handler (attractor §2.6 + §4.2). The
 * validator (E016 / W012) catches mismatches and unknown `type=` values at
 * validate-time; this helper is defensive — an unknown `type=` falls back
 * to the shape so the runtime stays well-defined even on an unvalidated
 * graph. */
export function handlerOf(node: Node): HandlerType {
  const t = node.attrs.type;
  if (typeof t === "string" && t.length > 0 && isHandlerType(t)) return t;
  return HANDLER_BY_SHAPE[node.shape];
}

export function isTerminal(node: Node): boolean {
  return node.shape === "Mdiamond" || node.shape === "Msquare";
}
