// Event types. Immutable records written to the EventSink.
// See docs/SPEC.md §3.5.

import type { FidelityMode } from "./fidelity.ts";
import type { Outcome } from "./outcome.ts";

export type EventType =
  // Pipeline lifecycle
  | "pipeline.started"
  | "pipeline.completed"
  | "pipeline.failed"
  // Node lifecycle
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "node.retrying"
  | "node.skipped"
  // Edge selection
  | "edge.selected"
  // Checkpoint
  | "checkpoint.saved"
  // Interview
  | "interview.started"
  | "interview.completed"
  | "interview.timeout"
  // Agent layer (bridged from pi in Phase 2)
  | "agent.start"
  | "agent.end"
  | "agent.turn_start"
  | "agent.turn_end"
  | "agent.message_start"
  | "agent.message_update"
  | "agent.message_end"
  | "agent.warning"
  // LLM layer
  | "llm.start"
  | "llm.text_delta"
  | "llm.thinking_delta"
  | "llm.toolcall_delta"
  | "llm.done"
  | "llm.error"
  // Tool layer
  | "tool.execution_start"
  | "tool.execution_update"
  | "tool.execution_end"
  // Steering
  | "steering.requested"
  | "steering.injected"
  // Cost
  | "cost.recorded";

/** Current event envelope version. Bumped when an incompatible field rename
 * or removal lands. Additive field changes do NOT bump this number; they're
 * picked up transparently by consumers that ignore unknown fields. */
export const EVENT_SCHEMA_VERSION = 1;

export interface Event {
  run_id: string;
  session_id?: string;
  node_id?: string;
  type: EventType;
  /** ISO-8601 timestamp. Tests may substitute a fixed clock. */
  timestamp: string;
  /** SHA of the workflow source for post-hoc reproducibility. */
  workflow_sha: string;
  /** Envelope version. Emitters stamp `EVENT_SCHEMA_VERSION`; pre-versioned
   * JSONL from older runs omits this field and consumers treat `undefined`
   * as `1` for back-compat. */
  schema_version?: number;
  data: Record<string, unknown>;
}

/** Typed convenience payloads for the most common events. */
export interface NodeCompletedData {
  outcome: Outcome;
  duration_ms: number;
  retry_count: number;
}

/**
 * Static inputs to a node — everything knowable before any substitution or
 * LLM call. Captured on `node.started` so a debugger can see the node's
 * configuration without re-parsing the DOT source. The *resolved* prompt
 * (post-substitution) is intentionally NOT here — it lives on `llm.start`
 * because loop/retry nodes resolve a different prompt per iteration.
 *
 * Values are optional because handlers without templates / context / tools
 * (start, exit, conditional, fan_in) simply omit them.
 */
export interface NodeStartedData {
  /** Handler key — `codergen`, `loop`, `wait.human`, `parallel`, ... */
  node_type?: string;
  /** Raw `node.attrs.prompt` before any substitution. */
  prompt_template?: string;
  /** Keys present in the ContextMap at the moment the handler starts.
   * Values elided to avoid payload blow-up and accidental secret leaks. */
  context_keys?: string[];
  /** Upstream node ids whose outputs are available for substitution. */
  node_outputs_in_scope?: string[];
  /** Model hint from `node.attrs.model` — authoritative binding is on `llm.start`. */
  model?: string;
  /** Provider hint from `node.attrs.provider`. */
  provider?: string;
  /** Resolved thread id (see engine/fidelity.ts). */
  thread_id?: string;
  /** Resolved fidelity mode (see engine/fidelity.ts). */
  fidelity?: FidelityMode;
  /** Tool allowlist from `node.attrs.allowed_tools`. */
  allowed_tools?: string[];
  /** Tool denylist from `node.attrs.denied_tools`. */
  denied_tools?: string[];
  /** `node.attrs.context_files` — paths loaded into the system prompt. */
  context_files?: string[];
}

/** Per-file record captured alongside the assembled system prompt. The
 * raw bytes are intentionally not carried on the event envelope — the sha
 * plus a flag is enough for a replay consumer to decide whether the file
 * has drifted between a run and its replay. */
export interface ContextFileCapture {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  status: "ok" | "missing";
  error?: string;
}

/** Generation settings captured per LLM call. All fields optional because not
 * every provider honours every knob, and some settings (top_p, stop) are
 * left at provider defaults today. When Wave 2 wires `reasoning_effort`
 * node attrs through to pi-ai, this is where the resolved value lands. */
export interface LlmSettings {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  reasoning_effort?: "low" | "medium" | "high";
  stop?: string[];
}

/** Serialisable snapshot of a single message in the agent's conversation at
 * the moment the LLM call is issued. We keep `content` as `unknown` because
 * pi-ai content is a discriminated union (text / image / tool call / tool
 * result); the emitter stores it verbatim and the UI / replay consumer
 * narrows as needed. */
export interface MessageSnapshot {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  timestamp?: number;
}

/** Read-only cumulative cost + token counters at the moment the LLM call is
 * issued. Wave 1 emits this as a placeholder ({0, 0}); Wave 4 wires it to a
 * real BudgetLedger so downstream nodes can enforce per-node / per-run
 * ceilings. Once populated, this is the single source of truth for "how
 * much has the run spent by step N" that UIs can render without summing
 * every `cost.recorded` themselves. */
export interface BudgetSnapshot {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  /** Node-level ceiling if `node.attrs.max_cost_usd` is set (Wave 4). */
  max_cost_usd?: number;
  /** Run-level ceiling if `graph.attrs.budget_usd` is set (Wave 4). */
  run_max_cost_usd?: number;
}

/**
 * Per-LLM-call record. Fires once per actual `backend.run()` invocation —
 * that means once for a codergen node, N times for a loop node with N
 * iterations, and zero times for non-LLM handlers. Carries the snapshot
 * of what the agent was actually asked so `events.jsonl` alone is enough
 * to reconstruct "what the agent saw at step N".
 */
export interface LlmStartData {
  provider?: string;
  model?: string;
  /** Fully substituted user prompt sent to the LLM. */
  prompt?: string;
  /** System prompt (context_files + configured system prompt) assembled
   * for this call. */
  system_prompt?: string;
  thread_id?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Loop iteration metadata when the call originates from a loop handler. */
  iteration?: { n: number; max: number };
  /** Prior conversation turns visible to the agent at call time. Empty on a
   * fresh session; non-empty when a shared `thread_id` restored a prior
   * pi-agent-core session. */
  messages?: MessageSnapshot[];
  /** Generation settings resolved for this call. */
  settings?: LlmSettings;
  /** Per-file records for every path listed in `node.attrs.context_files`.
   * Order matches the input. Durable enough to detect drift between a run
   * and its replay (compare sha256 per path). */
  context_files?: ContextFileCapture[];
  /** Read-only budget snapshot. See `BudgetSnapshot`. */
  budget?: BudgetSnapshot;
}

export interface EdgeSelectedData {
  from: string;
  to: string;
  /** Which of the 5 priority rules picked this edge. */
  rule: "condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical";
  matched_label?: string;
  matched_condition?: string;
}
