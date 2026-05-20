// Graph model: Nodes, Edges, and the Graph itself. See docs/SPEC.md §3.1.

import type { SummaryLevel } from "./summary.ts";

/** Node-type discriminator. `start` and `exit` are synthesised by the
 * parser (the entry and the reserved graceful-halt sink); authors only
 * declare `llm` / `human` / `tool` / `exit` (when an explicit type:exit
 * is canonical). */
export type NodeType = "start" | "exit" | "llm" | "human" | "tool";

/** Alias for legacy callsites; `HandlerType` and `NodeType` are now the
 * same vocabulary post-codergen-rename. */
export type HandlerType = NodeType;

/** Attribute values that survive YAML parsing + coercion. */
type AttrScalar = string | number | boolean | string[];

export interface NodeAttrs {
  label?: string;
  prompt?: string;
  /** Override the global system prompt for this step (authoring: `system-prompt`). */
  system_prompt?: string;
  /** Repo-relative files prepended to the system prompt as
   * `<project-conventions>` blocks (authoring: `context-files`). `AGENTS.md`
   * is auto-prepended. */
  context_files?: string[];
  /** Drop the skills catalogue from this step's system prompt
   * (authoring: `skills-disabled`). */
  skills_disabled?: boolean;
  /** Provider-native LLM model id. Examples: `claude-opus-4-7`. */
  model?: string;
  /** Provider key. E.g. `anthropic`, `openai`. */
  provider?: string;
  /** Summarise the prior thread before this node sees it. Requires
   * `thread_id` to be set (validator E027 enforces). Three levels map to
   * summariser output-token caps (low ~300 / medium ~700 / high ~1500).
   * Without `summary=`, a node on a thread sees the full raw history. */
  summary?: SummaryLevel;
  thread_id?: string;
  /** Set by the parser when authoring uses `retry: <step>`; pairs with
   * `retry_target` to drive §3.4 goal-gate retargets. */
  goal_gate?: boolean;
  /** Per-step retry cap (tool self-retry or goal-gate retarget cap). */
  max_retries?: number;
  /** Per-node hard timeout. Duration-string form (e.g. "30s", "5m", "2h").
   * Wins over `.swarm/config.jsonc` `timeouts.<kind>`. */
  timeout?: string;
  /** Per-node hard timeout in raw milliseconds. Mutex with `timeout`. */
  max_ms?: number;
  reasoning_effort?: "low" | "medium" | "high";
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Goal-gate retarget destination. Set by the parser when authoring
   * uses `retry: <step>`. References a step id. */
  retry_target?: string;
  /** Secondary goal-gate retarget, tried when `retry_target` is unset
   * (SPEC §3.4 chain). References a step id. */
  fallback_retry_target?: string;
  /** Tool-step config (type:tool). Shell command executed by the tool
   * handler. */
  tool_command?: string;
  /** Per-node cumulative cost ceiling in USD. Cumulative across all
   * iterations of this node within the run. */
  max_cost_usd?: number;
  /** Per-node cumulative token ceiling (input + output + cache). */
  max_tokens?: number;
  /** Scope the skills catalog visible to this node. Unset = all
   * discovered skills. Set = only these names appear in the
   * <available_skills> block of the system prompt. */
  skills?: string[];
  /** Routing targets this node may exit to via the `route` tool. */
  routes?: string[];
  /** Free-form text shown to the operator for type:human steps. */
  text?: string;
  [extra: string]: AttrScalar | undefined;
}

export interface EdgeAttrs {
  label?: string;
  thread_id?: string;
  /** Outcome-keyed edge — selected when the source node's last fact
   * reports this outcome. */
  outcome?: "success" | "fail";
  /** Route-keyed edge — selected when the source node's llm call exits
   * via `route({name: …})`. */
  route?: string;
  [extra: string]: AttrScalar | undefined;
}

/** A typed run-input declaration from the workflow's `inputs:` block.
 * Provided per-run via `--input name=value` and substituted into
 * `prompt:` / `text:` / `run:` strings as `${{ inputs.name }}`. */
export interface InputDecl {
  name: string;
  type: "string" | "boolean" | "number" | "choice";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

export interface GraphAttrs {
  goal?: string;
  label?: string;
  thread_id?: string;
  /** Per-run cost ceiling in USD. */
  budget_usd?: number;
  /** Policy when a budget threshold is crossed. */
  budget_policy?: "warn" | "stop" | "pause";
  /** Declared run inputs (the `inputs:` block). Substituted as
   * `${{ inputs.name }}`; validated against `--input` bindings at enqueue. */
  inputs?: InputDecl[];
  [extra: string]: AttrScalar | InputDecl[] | undefined;
}

export interface Location {
  line: number;
  col: number;
}

export interface Node {
  id: string;
  type: NodeType;
  attrs: NodeAttrs;
  /** Location in source for error reporting (1-indexed line/column). */
  loc?: Location;
}

export interface Edge {
  from: string;
  to: string;
  attrs: EdgeAttrs;
  loc?: Location;
}

export interface Graph {
  id: string;
  /** Directed graph (the only supported kind). */
  directed: true;
  attrs: GraphAttrs;
  nodes: Record<string, Node>;
  edges: Edge[];
}

/** Resolve a node's handler. With the unified NodeType/HandlerType
 * vocabulary post-codergen-rename, this is now an identity function —
 * kept as a stable seam for callsites and for the engine's intent of
 * "the handler to dispatch for this node". */
export function handlerOf(node: Node): HandlerType {
  return node.type;
}

export function isTerminal(node: Node): boolean {
  return node.type === "start" || node.type === "exit";
}
