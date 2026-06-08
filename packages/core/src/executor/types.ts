// LlmBackend / LlmInput — the contract @fragua/agent's
// PiLlmBackend implements so makeLlmHandler can drive it inside
// a HandlerContext.

import type { AgentMessage } from "@fragua/types";
import type { BudgetSnapshotInput } from "../handler/types.ts";
import type { EventType } from "../types/events.ts";
import type { ExecutionEnvironment } from "../types/execution.ts";
import type { Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";
import type { OutputsDecl } from "../types/outputs.ts";
import type { SummaryLevel } from "../types/summary.ts";

export type { BudgetSnapshotInput };

export interface LlmBackend {
  run(input: LlmInput): Promise<Outcome>;
}

export interface LlmInput {
  node: Node;
  prompt: string;
  /** Workflow `goal` attribute, threaded for the agent's system-prompt
   * framing. Optional; absent for graphs with no `goal=`. */
  goal?: string;
  thread_id: string | undefined;
  /** Optional thread-summary level. Requires `thread_id` to be set; when
   * present, the backend invokes the summariser on the prior thread
   * before the node sees it (low/medium/high cap the output tokens).
   * When absent on a threaded node, the raw thread is hydrated. */
  summary?: SummaryLevel;
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
   * overrides the in-process MessageStore cache. This is how a
   * threaded node survives a daemon restart: the in-memory cache is
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
  /** Outputs declared by the current node (forwarded from `node.attrs.outputs`).
   * Used by the backend to synthesise the `emit_output` tool. */
  outputsDecl?: OutputsDecl;
}
