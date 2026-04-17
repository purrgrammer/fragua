// Event types. Immutable records written to the EventSink.
// See docs/SPEC.md §3.5.

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

export interface EdgeSelectedData {
  from: string;
  to: string;
  /** Which of the 5 priority rules picked this edge. */
  rule: "condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical";
  matched_label?: string;
  matched_condition?: string;
}
