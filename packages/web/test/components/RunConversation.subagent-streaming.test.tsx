// RunConversation — parallel subagent streaming.
//
// When multiple agents run in parallel via the `agent` tool, each
// subagent's persisted messages already render inline inside the
// parent's matching `agent` toolCall card (via `subagent-transcript-<sid>`).
// The streaming buffer (mid-message deltas, before `agent.message_end`
// promotes them to a persisted row) must follow the same rule:
// a streaming row whose `nodeId === "__subagent:<sid>"` belongs
// inside that subagent's tool card, not as an orphan node section
// at the bottom of the conversation.
//
// Today the streaming buffer falls through every case in
// RunConversation's render planning (it isn't a main-section nodeId,
// it isn't in any branch tab) and ends up rendered via the
// `orphanStreaming` branch as a synthetic `__subagent:<sid>`
// NodeSection — visually divorced from the parent's `agent` card.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { RunMessageRow } from "../../src/lib/api.ts";
import type { StreamingMessage } from "../../src/lib/useRunLive.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function parentSpawningTwoAgents(): RunMessageRow[] {
  // Parent's transcript: two `agent` toolCalls (sidA + sidB), each
  // with a matching toolResult carrying `details.data.subagent_id`.
  // Models: caller dispatched two parallel subagents and the persisted
  // turn already exists in the messages table.
  return [
    {
      ordinal: 1,
      nodeId: "root",
      content: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-A",
            name: "agent",
            arguments: { name: "researcher", prompt: "go" },
          },
          {
            type: "toolCall",
            id: "call-B",
            name: "agent",
            arguments: { name: "writer", prompt: "go" },
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "toolUse",
      } as never,
    },
    {
      ordinal: 2,
      nodeId: "root",
      content: {
        role: "toolResult",
        toolCallId: "call-A",
        toolName: "agent",
        content: [{ type: "text", text: "(subagent A still running)" }],
        details: { swarm_tool: "agent", data: { subagent_id: "sidA" } },
      } as never,
    },
    {
      ordinal: 3,
      nodeId: "root",
      content: {
        role: "toolResult",
        toolCallId: "call-B",
        toolName: "agent",
        content: [{ type: "text", text: "(subagent B still running)" }],
        details: { swarm_tool: "agent", data: { subagent_id: "sidB" } },
      } as never,
    },
  ];
}

describe("RunConversation — parallel subagent streaming", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders an in-flight subagent stream inline inside its parent's agent toolCall card, not as an orphan section", () => {
    const messages = parentSpawningTwoAgents();
    // Streaming buffer tagged for subagent A — mid-message text deltas
    // landed before any `agent.message_end` could promote them to a
    // persisted message row.
    const streaming: StreamingMessage = {
      nodeId: "__subagent:sidA",
      blocks: [{ type: "text", index: 0, text: "researching the codebase…" }],
    };

    const { container } = renderWithClient(<RunConversation messages={messages} streaming={streaming} isLive />);
    const q = within(container);

    // There must NOT be an orphan `__subagent:sidA` node section
    // floating outside the parent's agent card.
    expect(q.queryByTestId("node-section-__subagent:sidA")).toBeNull();

    // Sub-agent toolCall cards default to collapsed (Radix unmounts
    // children when closed). Expand subagent A's card to verify the
    // streaming row is rendered inside it.
    const cardA = q.getByTestId("tool-call-A");
    const triggerA = cardA.querySelector('[data-slot="collapsible-trigger"]') as HTMLButtonElement | null;
    expect(triggerA).not.toBeNull();
    act(() => {
      fireEvent.click(triggerA as HTMLButtonElement);
    });

    // The parent's `agent` toolCall card for subagent A must contain the
    // streaming message row.
    const sidACard = q.getByTestId("subagent-transcript-sidA");
    expect(within(sidACard).getByTestId("streaming-message")).toBeTruthy();
  });
});
