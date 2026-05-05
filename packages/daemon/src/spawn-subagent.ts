// makeSpawnSubagent — the per-call factory that connects a parent
// codergen turn's `agent` tool to the child run lifecycle.
//
// The 9-step protocol from `docs/proposals/agent-tool.md`:
//
//   1. Filter parent skills by `spec.skills` (intersection by name).
//   2. Materialise the child's system prompt (override or inherit).
//   3. Compute the child's tool pool (parent's pool, narrowed by
//      `spec.allowed_tools` / `spec.disallowed_tools`, then strip
//      `agent` so children can't recursively spawn).
//   4. Insert a conversation row keyed by a fresh `child_run_id`.
//   5. Append `fact.subagent.spawned` to the PARENT's stream
//      (observability writer — no version bump on the parent).
//   6. Drive the child run to terminal via runConversation.
//   7. Read the child's last assistant message + terminal status.
//   8. Append `fact.subagent.completed` to the parent's stream.
//   9. Return the summary payload to the `agent` tool.
//
// Parent cancellation propagates through `spec.signal` → an
// `intent.cancel_requested` on the child, which the conversation
// runner picks up via the standard fold.

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { materialiseForChild } from "@swarm/agent";
import type { CodergenBackend } from "@swarm/core";
import type { IEventStore, ObservabilityEvent } from "@swarm/store";
import type { AnyTool, Skill, SubagentResult, SubagentSpec, ToolRegistry } from "@swarm/workspace";
import { stripAgentTool } from "@swarm/workspace";
import { runConversation } from "./conversation.ts";

export interface SpawnSubagentDeps {
  store: IEventStore;
  registry: ToolRegistry;
  backend: CodergenBackend;
  shutdownSignal: AbortSignal;
}

export interface SpawnSubagentParentCtx {
  parentRunId: string;
  parentNodeId: string;
  parentIteration: number;
  parentSystemPrompt: string;
  parentSkills: readonly Skill[];
  parentAllowedTools?: readonly string[];
  parentDeniedTools?: readonly string[];
  cwd?: string;
}

/** Build a `spawnSubagent` closure scoped to one parent codergen call.
 *  Wired by the daemon into `PiCodergenBackend.spawnSubagentFactory`
 *  so `swarmContext.spawnSubagent` resolves per call. */
export function makeSpawnSubagent(
  deps: SpawnSubagentDeps,
  parentCtx: SpawnSubagentParentCtx,
): (spec: SubagentSpec) => Promise<SubagentResult> {
  return async (spec) => {
    // Step 2: build the child's system prompt + skill catalog.
    const { systemPrompt: childSystemPrompt, effectiveSkills } = materialiseForChild(
      {
        ...(spec.system_prompt !== undefined ? { system_prompt: spec.system_prompt } : {}),
        ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
      },
      parentCtx.parentSystemPrompt,
      parentCtx.parentSkills,
    );

    // Step 3: child's tool pool. Start from parent allow/deny;
    // `spec.allowed_tools` / `spec.disallowed_tools` narrow further;
    // strip `agent` so children can't nest sub-agents.
    const allow = spec.allowed_tools ?? parentCtx.parentAllowedTools;
    const deny = spec.disallowed_tools ?? parentCtx.parentDeniedTools;
    const selectOpts: { allow?: readonly string[]; deny?: readonly string[] } = {};
    if (allow !== undefined) selectOpts.allow = allow;
    if (deny !== undefined) selectOpts.deny = deny;
    const childPool: AnyTool[] = stripAgentTool(
      deps.registry.select({
        ...(allow !== undefined ? { allow: [...allow] } : {}),
        ...(deny !== undefined ? { deny: [...deny] } : {}),
      }),
    );

    // Step 4: enqueue the child as a conversation run.
    const childRunId = `conv-${randomUUID()}`;
    deps.store.enqueueConversation({
      runId: childRunId,
      parentRunId: parentCtx.parentRunId,
      parentNodeId: parentCtx.parentNodeId,
      parentIteration: parentCtx.parentIteration,
      ...(parentCtx.cwd !== undefined ? { cwd: parentCtx.cwd } : {}),
      initialRouting: {
        input: spec.prompt,
        "agent.system_prompt": childSystemPrompt,
        "agent.tool_pool": childPool.map((t) => t.name),
        "agent.skills": effectiveSkills.map((s) => s.name),
        ...(spec.max_iterations !== undefined ? { "agent.max_iterations": spec.max_iterations } : {}),
        ...(spec.description !== undefined ? { "agent.label": spec.description } : {}),
      },
    });

    // Step 5: spawn fact on the parent's stream (observability).
    const spawnedPayload: Record<string, unknown> = {
      parent_node_id: parentCtx.parentNodeId,
      iteration: parentCtx.parentIteration,
      child_run_id: childRunId,
    };
    if (spec.description !== undefined) spawnedPayload["label"] = spec.description;
    deps.store.appendObservabilityEvents(parentCtx.parentRunId, [
      { type: "fact.subagent.spawned", payload: spawnedPayload },
    ]);

    // Wire abort propagation. A parent-side abort fires
    // `intent.cancel_requested` on the child, which the conversation
    // runner picks up on the next fold. We don't await the cancel
    // synchronously — the child's own teardown handles it.
    const onAbort = () => {
      try {
        deps.store.appendIntent(childRunId, {
          type: "intent.cancel_requested",
          payload: { reason: "parent cancelled" },
        });
      } catch {
        // best-effort
      }
    };
    if (spec.signal) {
      if (spec.signal.aborted) onAbort();
      else spec.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Step 6: drive the child to terminal.
    try {
      await runConversation(childRunId, {
        store: deps.store,
        backend: deps.backend,
        shutdownSignal: deps.shutdownSignal,
      });
    } finally {
      if (spec.signal) spec.signal.removeEventListener("abort", onAbort);
    }

    // Step 7: read terminal status + last assistant message.
    const childState = deps.store.getState(childRunId);
    const messages = deps.store.getMessages(childRunId);
    const summary = lastAssistantText(messages.map((m) => m.content));
    const totalToolCalls = countToolCalls(messages.map((m) => m.content));
    const status = childState?.status ?? "halted";

    // Step 8: completion fact on the parent's stream.
    const completedEvent: ObservabilityEvent = {
      type: "fact.subagent.completed",
      payload: {
        child_run_id: childRunId,
        status,
        summary_chars: summary.length,
        total_tool_calls: totalToolCalls,
      },
    };
    deps.store.appendObservabilityEvents(parentCtx.parentRunId, [completedEvent]);

    // Step 9: surface the result to the `agent` tool.
    const result: SubagentResult = {
      summary,
      childRunId,
      status,
      totalToolCalls,
    };
    if (status === "halted") {
      const halt = deriveHaltReason(deps.store, childRunId);
      if (halt !== undefined) result.haltReason = halt;
    }
    return result;
  };
}

/** Concatenate every text block on the most recent assistant message.
 *  Returns "" when no assistant message landed (the child terminated
 *  before producing one). */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m == null) continue;
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    const parts = m.content as Array<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/** Count tool calls across the child's transcript. Each assistant
 *  message with a `toolCall` block counts; multiple tool blocks on one
 *  message count individually. */
function countToolCalls(messages: AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type: string }>) {
      if (block.type === "toolCall") n += 1;
    }
  }
  return n;
}

/** Pull the most recent halt reason off the child's event log. The
 *  conversation runner writes one `fact.run_halted` per terminal halt;
 *  we read it back so the parent sees a structured failure cause. */
function deriveHaltReason(store: IEventStore, runId: string): SubagentResult["haltReason"] {
  const events = store.getEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== "fact.run_halted") continue;
    const reason = (e.payload as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string") return reason as SubagentResult["haltReason"];
  }
  return undefined;
}
