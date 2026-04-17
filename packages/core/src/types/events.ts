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

export interface Event {
  run_id: string;
  session_id?: string;
  node_id?: string;
  type: EventType;
  /** ISO-8601 timestamp. Tests may substitute a fixed clock. */
  timestamp: string;
  /** SHA of the workflow source for post-hoc reproducibility. */
  workflow_sha: string;
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

/**
 * Per-LLM-call record. Fires once per actual `backend.run()` invocation —
 * that means once for a codergen node, N times for a loop node with N
 * iterations, and zero times for non-LLM handlers. Carries the snapshot
 * of what the agent was actually asked.
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
}

export interface EdgeSelectedData {
  from: string;
  to: string;
  /** Which of the 5 priority rules picked this edge. */
  rule: "condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical";
  matched_label?: string;
  matched_condition?: string;
}
