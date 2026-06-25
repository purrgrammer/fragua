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

// `retryCountKey` and `AUTO_RESUME_AT_KEY` are part of the dotted-key routing
// vocabulary and live in `../routing.ts` (the typed-routing accessor module,
// the single source of truth for routing keys). Imported from `@fragua/core`.
