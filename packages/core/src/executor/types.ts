// CodergenBackend / CodergenInput — the contract @swarm/agent's
// PiCodergenBackend implements so makeCodergenHandler can drive it inside
// a HandlerContext.

import type { AgentMessage } from "@swarm/types";
import type { BudgetSnapshotInput } from "../handler/types.ts";
import type { EventType } from "../types/events.ts";
import type { ExecutionEnvironment } from "../types/execution.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import type { Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";

export type { BudgetSnapshotInput };

export interface CodergenBackend {
  run(input: CodergenInput): Promise<Outcome>;
}

export interface CodergenInput {
  node: Node;
  prompt: string;
  /** Workflow `goal` attribute, threaded for the agent's system-prompt
   * framing. Optional; absent for graphs with no `goal=`. */
  goal?: string;
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
  /** Snapshot of the budget state as of the start of this dispatch.
   * The executor computes this from `run_state.metrics` + the graph /
   * node ceilings; the backend embeds it verbatim into `llm.start.budget`
   * so the UI can render "X of Y used" without cross-referencing the
   * graph attrs. Optional: omitted when no ceiling is configured. */
  budgetSnapshot?: BudgetSnapshotInput;
  /** When true, the backend uses `node.attrs.system_prompt` (or the
   * empty string when absent) as the COMPLETE system prompt — no
   * framework skills catalog, no context-files block, no run-env
   * description. Used by the `agent` tool's spawn path so
   * the calling LLM has full control over the sub-agent's context
   * window: framework injection-by-default would change the shape of
   * the call the parent constructed without asking. */
  skipFrameworkSystemPrompt?: boolean;
}
