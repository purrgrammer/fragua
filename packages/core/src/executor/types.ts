// CodergenBackend / CodergenInput — the contract @swarm/agent's
// PiCodergenBackend implements so makeCodergenHandler can drive it inside
// a HandlerContext.

import type { ContextMap } from "../types/context.ts";
import type { EventType } from "../types/events.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import type { Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";

export interface CodergenBackend {
  run(input: CodergenInput): Promise<Outcome>;
}

export interface CodergenInput {
  node: Node;
  prompt: string;
  context: ContextMap;
  thread_id: string | undefined;
  fidelity: FidelityMode;
  signal: AbortSignal;
  run_id: string;
  workflow_sha: string;
  /** Backend-emitted sub-events (cost.recorded, agent.message_end, …).
   * The handler-bridge collects cost + assistant/tool messages from
   * these callbacks; unrecognised types are ignored. */
  emit?: (type: EventType, data: Record<string, unknown>) => Promise<void>;
  /** Optional loop iteration metadata for handlers dispatched from a loop. */
  iteration?: { n: number; max: number };
  /** Persisted prior transcript for this (runId, threadId), loaded
   * from the messages table by the handler-bridge. When set and
   * non-empty, the backend treats it as the authoritative history — it
   * overrides the in-process MessageStore cache. This is how
   * `fidelity=full` survives a daemon restart: the in-memory cache is
   * empty after restart but the messages table still has the rows.
   *
   * Left as `unknown[]` at the core boundary so @swarm/core doesn't
   * depend on pi-agent-core's AgentMessage shape; the backend casts. */
  priorMessages?: readonly unknown[];
  /** Sink for persisting LLM-visible assistant / tool messages as they
   * complete. The backend calls this once per finished agent message
   * with its reconstituted content plus the structured payload so
   * resume can rehydrate the exact AgentMessage shape. The handler-
   * bridge wires it to `ctx.messages.append` so rows land in the
   * `messages` table (no 4KB payload cap, unlike the events table —
   * §I7 vs §I9). When omitted, messages don't land anywhere — fine
   * for tests that only care about events. `payloadJson` is a JSON-
   * serialized AgentMessage; the messages table stores it verbatim. */
  persistMessage?: (role: "assistant" | "tool" | "user" | "system", content: string, payloadJson?: string) => void;
}
