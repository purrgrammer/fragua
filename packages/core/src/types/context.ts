// Run Context: shared KV carried through a run. See docs/SPEC.md §3.2.

import type { ContextValue } from "./outcome.ts";

export type ContextMap = Record<string, ContextValue>;

/** Engine-managed keys, set after each node. */
export const ENGINE_CONTEXT_KEYS = {
  outcome: "outcome",
  preferred_label: "preferred_label",
  current_node: "current_node",
  last_stage: "last_stage",
  last_response: "last_response",
  run_id: "graph.run_id",
  goal: "graph.goal",
} as const;

export function retryCountKey(nodeId: string): string {
  return `internal.retry_count.${nodeId}`;
}

/** Routing key holding the wall-clock ms timestamp at which a
 * `paused_retry` run becomes wake-eligible. Set when the executor emits
 * `fact.run_paused_retry`; read by `wakeRetryDelays` (daemon
 * wake-pending). Cleared implicitly when the run leaves `paused_retry`
 * — the routing key persists but is ignored once status moves on. */
export const RETRY_RESUME_AT_KEY = "internal.retry_resume_at";
