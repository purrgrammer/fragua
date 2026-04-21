// CodergenBackend / CodergenInput — the contract @swarm/agent's
// PiCodergenBackend implements so makeCodergenHandler can drive it inside
// a HandlerContext.

import type { AgentMessage } from "@swarm/types";
import type { ContextMap } from "../types/context.ts";
import type { EventType } from "../types/events.ts";
import type { ExecutionEnvironment } from "../types/execution.ts";
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
   * empty after restart but the messages table still has the rows. */
  priorMessages?: readonly AgentMessage[];
  /** Sink for persisting LLM-visible messages as they complete. The
   * backend calls this once per `agent.message_end` with the full
   * `AgentMessage` (text + thinking + toolCall blocks, or toolResult +
   * tool_use_id pairing, or a custom-type like `SystemPromptMessage`).
   * The handler-bridge wires it to `ctx.messages.append` so rows land
   * in the `messages` table (§I9 — JSON, unbounded, distinct from the
   * 4KB event payload cap §I7). When omitted, messages don't land
   * anywhere — fine for tests that only care about events. */
  persistMessage?: (message: AgentMessage) => void;
  /** Per-run shell + filesystem environment. When set, the backend
   * uses this for tool execution (read/write/edit/bash) and context-
   * file loads instead of falling back to its construction-time env.
   * This is how per-run worktree isolation reaches the agent. */
  env?: ExecutionEnvironment;
}
