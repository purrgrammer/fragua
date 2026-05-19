// Run Context: shared KV carried through a run. See docs/SPEC.md §3.2.

import type { ContextValue } from "./outcome.ts";

export type ContextMap = Record<string, ContextValue>;

/** Engine-managed keys, set after each node. */
export const ENGINE_CONTEXT_KEYS = {
  outcome: "outcome",
  current_node: "current_node",
  last_stage: "last_stage",
  last_response: "last_response",
  run_id: "graph.run_id",
  goal: "graph.goal",
} as const;

export function retryCountKey(nodeId: string): string {
  return `internal.retry_count.${nodeId}`;
}

/** Routing key holding the wall-clock ms timestamp at which a paused
 * run with auto-resume becomes wake-eligible. Used by both reasons
 * that project to `paused_auto`: `handler_retry` (set when emitting
 * `fact.run_paused{reason:"handler_retry"}`) and `provider_retry`
 * (set when emitting `fact.run_paused{reason:"provider_retry"}`).
 * Read by `wakeAutoResume` (daemon wake-pending). Cleared implicitly
 * when the run leaves an auto-paused state — the routing key persists
 * but is ignored once status moves on. */
export const AUTO_RESUME_AT_KEY = "internal.auto_resume_at";
