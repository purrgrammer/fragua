// Graph model: Nodes, Edges, and the Graph itself. See docs/SPEC.md §3.1.

import type { RetryPresetName } from "../engine/retry-policy.ts";
import type { OutputProfile, OutputsDecl } from "./outputs.ts";
import type { SummaryLevel } from "./summary.ts";

/** Node-type discriminator. `start` and `exit` are synthesised by the
 * parser (the entry and the reserved graceful-halt sink); authors only
 * declare `llm` / `human` / `tool` / `exit` (when an explicit type:exit
 * is canonical). */
export type NodeType = "start" | "exit" | "llm" | "human" | "tool" | "parallel";

/** Alias for legacy callsites; `HandlerType` and `NodeType` are now the
 * same vocabulary post-codergen-rename. */
export type HandlerType = NodeType;

/** Attribute values that survive YAML parsing + coercion. */
export type AttrScalar = string | number | boolean | string[];

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
   * Wins over `.fragua/config.yaml` `timeouts.<kind>`. */
  timeout?: string;
  /** Per-node hard timeout in raw milliseconds. Mutex with `timeout`. */
  max_ms?: number;
  reasoning_effort?: "low" | "medium" | "high";
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Goal-gate retarget destination. Set by the parser when authoring
   * uses `retry: <step>`. References a step id. */
  retry_target?: string;
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
  /** Branch ENTRY node ids of a `type: parallel` fan-out (Model A,
   * docs/proposals/fan-out-nodes.md). The take-all set: every branch runs
   * concurrently within one run; each branch is a sub-pipeline (the entry plus
   * its intra-closure `next:`/`routes:` reach) converging on the join
   * (`parallel.next`). Distinct, ≥2, read-class llm nodes (validator E036–E043). */
  branches?: string[];
  /** Max in-flight sub-nodes for a `type: parallel` fan-out — a semaphore the
   * frontier loop acquires before each sub-node dispatch. Unset ⇒ the
   * configured global default (`fanout.max_concurrency`). Bounds a wide static
   * set and is `map`'s prerequisite. */
  concurrency?: number;
  /** The join (post-barrier sink) of a `type: parallel` fan-out — the node the
   * branches converge on, resolved from the parallel node's `next:`. The
   * executor advances `current_node` here when the frontier drains; the join
   * reads each branch terminal's outputs by name. */
  join?: string;
  /** Typed output declarations for this step (llm steps only). Keys are output
   * names; values are restricted-profile type nodes. Validated at parse time and
   * lowered to a provider-enforced TypeBox schema for the `emit_output` tool.
   * See docs/proposals/structured-outputs.md. */
  outputs?: OutputsDecl;
  /** Free-form text shown to the operator for type:human steps. */
  text?: string;
  /** Backoff preset for handler retries (authoring: `retry-policy`). Resolution
   * order: node → graph.default_retry_policy → "none". */
  retry_policy?: RetryPresetName;
  /** Per-node override: first retry delay in ms (authoring: `retry-initial-delay-ms`). */
  retry_initial_delay_ms?: number;
  /** Per-node override: backoff multiplier (authoring: `retry-backoff-factor`). */
  retry_backoff_factor?: number;
  /** Per-node override: delay cap in ms (authoring: `retry-max-delay-ms`). */
  retry_max_delay_ms?: number;
  /** Per-node override: enable ±50% jitter (authoring: `retry-jitter`). */
  retry_jitter?: boolean;
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
  /** Synthesized edge of a `type: parallel` fan-out — either `parallel → entry`
   * (take-all) or `terminal → join` (the barrier). Lets the validator and
   * executor tell a branch's structural edges from author-declared successors.
   * docs/proposals/fan-out-nodes.md § DSL. */
  fanout?: boolean;
}

/** A typed run-input declaration from the workflow's `inputs:` block.
 * Provided per-run via `--input name=value` and substituted into
 * `prompt:` / `text:` / `run:` strings as `${{ inputs.name }}`. */
export interface InputDecl {
  name: string;
  type: "string" | "boolean" | "number" | "choice" | "object" | "array";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
  /** Parsed type profile when `type: object` or `type: array` — the SAME
   * restricted grammar `outputs:` uses (record `fields:` + `required`, array
   * `items:`, nesting to any fixed depth). Absent for scalar/choice inputs. */
  profile?: OutputProfile;
}

/** A run-level output declaration from the workflow's top-level `outputs:`
 * block. PROJECTS a step output into the run's typed result. `node` is the
 * producer step id and `path` the dotted suffix (empty = the producer's whole
 * struct); together they mirror the `${{ outputs.<node>.<field> }}` token's
 * addressing, MINUS the wrapper and MINUS fail-closed — the run boundary is
 * typed-partial (an unproduced output is absent, never a halt). The projected
 * type is the referenced field's type (the §5 grammar; no new type surface).
 * See docs/proposals/structured-outputs.md §11. */
export interface RunOutputDecl {
  name: string;
  /** Producer step id (the `<node>` of `from: <node>.<path>`). */
  node: string;
  /** Dotted suffix selecting a leaf/sub-record; empty for a bare
   * `from: <node>` (the producer's whole struct). */
  path: string[];
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
  /** Declared run-level outputs (the top-level `outputs:` block). Each entry
   * projects a step output into the run's typed result; surfaced as
   * `RunDetail.outputs` (a read-plane projection, typed-partial). */
  outputs?: RunOutputDecl[];
  /** Graph-level fallback backoff preset when a node omits `retry-policy`
   * (authoring: `default-retry-policy`). */
  default_retry_policy?: RetryPresetName;
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
