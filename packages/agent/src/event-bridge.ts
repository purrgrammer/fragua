// Translate pi-agent-core AgentEvents into swarm Event types.
// See docs/SPEC.md §3.5.

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { EventType } from "@swarm/core";
import { unsanitizeToolName } from "./tool-adapter.ts";

export interface BridgedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

/** Extract an AssistantMessage's usage + cost into a cost.recorded payload.
 *
 * Cost split between input/output tokens prefers `usage.reportedCost`
 * (authoritative when the provider returns it via OpenRouter-style
 * `usage: { include: true }`), falling back to pi-ai's locally-computed
 * `usage.cost.input` / `usage.cost.output`. */
export function costPayload(msg: AssistantMessage): Record<string, unknown> {
  const inputCost = msg.usage.reportedCost?.input ?? msg.usage.cost.input;
  const outputCost = msg.usage.reportedCost?.output ?? msg.usage.cost.output;
  return {
    provider: msg.provider,
    model: msg.model,
    stop_reason: msg.stopReason,
    input_tokens: msg.usage.input,
    output_tokens: msg.usage.output,
    cache_read_tokens: msg.usage.cacheRead,
    cache_write_tokens: msg.usage.cacheWrite,
    total_tokens: msg.usage.totalTokens,
    cost_usd: msg.usage.cost.total,
    cost_input_usd: inputCost,
    cost_output_usd: outputCost,
  };
}

/** Map a pi AgentEvent to a swarm Event envelope payload. Returns undefined for
 * events we intentionally drop (e.g. internal streaming updates that would
 * flood the log). */
export function bridgeAgentEvent(event: AgentEvent): BridgedEvent | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: "agent.start", data: {} };
    case "agent_end":
      return { type: "agent.end", data: { message_count: event.messages.length } };
    case "turn_start":
      return { type: "agent.turn_start", data: {} };
    case "turn_end":
      return {
        type: "agent.turn_end",
        data: {
          role: event.message.role,
          tool_result_count: event.toolResults.length,
        },
      };
    case "message_start":
      return { type: "agent.message_start", data: { role: event.message.role } };
    case "message_update":
      // Fold per-chunk streaming deltas under llm.* — filter by kind.
      return bridgeMessageUpdate(event.assistantMessageEvent);
    case "message_end":
      return { type: "agent.message_end", data: { role: event.message.role } };
    case "tool_execution_start":
      return {
        type: "tool.execution_start",
        data: { tool_call_id: event.toolCallId, tool_name: unsanitizeToolName(event.toolName), args: event.args },
      };
    case "tool_execution_update":
      return {
        type: "tool.execution_update",
        data: {
          tool_call_id: event.toolCallId,
          tool_name: unsanitizeToolName(event.toolName),
          partial: event.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        type: "tool.execution_end",
        data: {
          tool_call_id: event.toolCallId,
          tool_name: unsanitizeToolName(event.toolName),
          is_error: event.isError,
          result: event.result,
        },
      };
    default:
      return undefined;
  }
}

type AssistantStreamEvent = Extract<AgentEvent, { type: "message_update" }>["assistantMessageEvent"];

function bridgeMessageUpdate(e: AssistantStreamEvent): BridgedEvent | undefined {
  switch (e.type) {
    case "start":
      // swarm's `llm.start` fires once per `backend.run()` with the resolved
      // prompt + system prompt (see PiCodergenBackend.run). Don't duplicate
      // it on every pi-agent message_start — `agent.message_start` already
      // marks message boundaries inside a turn.
      return undefined;
    case "text_delta":
      return { type: "llm.text_delta", data: { delta: e.delta, content_index: e.contentIndex } };
    case "thinking_delta":
      return { type: "llm.thinking_delta", data: { delta: e.delta, content_index: e.contentIndex } };
    case "toolcall_delta":
      return { type: "llm.toolcall_delta", data: { delta: e.delta, content_index: e.contentIndex } };
    case "done":
      return { type: "llm.done", data: { stop_reason: e.reason } };
    case "error":
      return {
        type: "llm.error",
        data: { reason: e.reason, message: e.error.errorMessage ?? "" },
      };
    default:
      return undefined;
  }
}
