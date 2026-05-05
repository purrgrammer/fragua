// EventType — the string-literal union of every event swarm emits.
// Lives in @swarm/types (not @swarm/core) so web + agent + daemon
// can reference the same list without pulling core's pure-reducer
// dependency tree.
//
// Envelope types (EventPayloadMap, FactEvent, IntentEvent,
// ObservabilityEvent) stay in @swarm/core/src/types/events.ts — they
// have deeper deps (Outcome, FidelityMode, SummariserBackend) that
// don't belong in the types-only package.

export type EventType =
  // Run lifecycle
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
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
  // Agent layer (bridged from pi)
  | "agent.start"
  | "agent.end"
  | "agent.turn_start"
  | "agent.turn_end"
  | "agent.message_start"
  | "agent.message_update"
  | "agent.message_end"
  | "agent.warning"
  | "agent.info"
  // LLM layer
  | "llm.start"
  | "llm.text_delta"
  | "llm.text_end"
  | "llm.thinking_delta"
  | "llm.thinking_end"
  | "llm.toolcall_delta"
  | "llm.toolcall_end"
  | "llm.done"
  | "llm.error"
  // Tool layer
  | "tool.execution_start"
  | "tool.execution_update"
  | "tool.execution_end"
  // Steering (legacy — replay only)
  | "steering.requested"
  | "steering.injected"
  // Control channel (steer / pause / resume / cancel)
  | "control.requested"
  | "control.applied"
  | "control.rejected"
  // Summariser
  | "summary.started"
  | "summary.text_delta"
  | "summary.completed"
  | "run.title_generated"
  // Budget
  | "budget.warn"
  | "budget.stop"
  // Cost
  | "cost.recorded"
  // Sub-agent boundaries (observability-only). Bracket the slice of
  // events produced by an inline `agent`-tool spawn on the parent's
  // stream; every event in between carries `subagent_id` on its
  // payload.
  | "subagent.start"
  | "subagent.end";

/** Every EventType value as a const array, suitable for iteration.
 * Consumers like `EventSource.addEventListener(<type>, ...)` register
 * handlers per type up front; sharing this list avoids drift between
 * the union and the registered names. Keep in sync with `EventType`
 * above — a CI test pins the mapping. */
export const ALL_EVENT_TYPES: readonly EventType[] = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "node.started",
  "node.completed",
  "node.failed",
  "node.retrying",
  "node.skipped",
  "edge.selected",
  "checkpoint.saved",
  "interview.started",
  "interview.completed",
  "interview.timeout",
  "agent.start",
  "agent.end",
  "agent.turn_start",
  "agent.turn_end",
  "agent.message_start",
  "agent.message_update",
  "agent.message_end",
  "agent.warning",
  "agent.info",
  "llm.start",
  "llm.text_delta",
  "llm.text_end",
  "llm.thinking_delta",
  "llm.thinking_end",
  "llm.toolcall_delta",
  "llm.toolcall_end",
  "llm.done",
  "llm.error",
  "tool.execution_start",
  "tool.execution_update",
  "tool.execution_end",
  "steering.requested",
  "steering.injected",
  "control.requested",
  "control.applied",
  "control.rejected",
  "summary.started",
  "summary.text_delta",
  "summary.completed",
  "run.title_generated",
  "budget.warn",
  "budget.stop",
  "cost.recorded",
  "subagent.start",
  "subagent.end",
];
