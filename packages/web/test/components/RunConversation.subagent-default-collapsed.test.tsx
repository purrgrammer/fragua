// RunConversation — sub-agent toolCall card default-collapsed.
//
// On the Run detail Conversation tab, every parent `agent` toolCall
// renders as a Tool card with the sub-agent's transcript embedded in
// its body. Today the card opens by default whenever an embedded
// transcript exists — both for finished runs (persisted sub-agent
// rows) and while a sub-agent is mid-stream. That's noisy: the
// conversation is a wall of expanded sub-agent panes by default.
//
// Default behaviour should be COLLAPSED. The user clicks the row to
// expand it. (A separate concern — preserving per-pane open state
// across streaming deltas — is covered elsewhere; this file pins the
// default.)

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { RunMessageRow } from "../../src/lib/api.ts";
import type { StreamingMessage } from "../../src/lib/useRunLive.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function parentAgentToolCallWithPersistedSubagent(): RunMessageRow[] {
  // Parent assistant turn: one `agent` toolCall (sidA), with the
  // matching toolResult carrying the canonical subagent_id link, and
  // one persisted sub-agent assistant message under `__subagent:sidA`.
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
        content: [{ type: "text", text: "done" }],
        details: { swarm_tool: "agent", data: { subagent_id: "sidA" } },
      } as never,
    },
    {
      ordinal: 3,
      nodeId: "__subagent:sidA",
      content: {
        role: "assistant",
        content: [{ type: "text", text: "I researched the codebase." }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
      } as never,
    },
  ];
}

describe("RunConversation — sub-agent toolCall card defaults to collapsed", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the parent `agent` toolCall card collapsed by default on initial load of a finished run", () => {
    const messages = parentAgentToolCallWithPersistedSubagent();

    const { container } = renderWithClient(<RunConversation messages={messages} />);
    const q = within(container);

    // The parent agent card exists.
    const card = q.getByTestId("tool-call-A");

    // Radix Collapsible's root carries `data-state="open"|"closed"`.
    // Default behaviour: closed.
    expect(card.getAttribute("data-state")).toBe("closed");
  });

  it("renders the parent `agent` toolCall card collapsed by default while the sub-agent is streaming", () => {
    // Just the parent's toolCall + toolResult — no persisted sub-agent
    // rows yet; deltas are arriving via `streaming`.
    const messages = parentAgentToolCallWithPersistedSubagent().slice(0, 2);
    const streaming: StreamingMessage = {
      nodeId: "__subagent:sidA",
      blocks: [{ type: "text", index: 0, text: "researching…" }],
    };

    const { container } = renderWithClient(<RunConversation messages={messages} streaming={streaming} isLive />);
    const q = within(container);

    const card = q.getByTestId("tool-call-A");
    expect(card.getAttribute("data-state")).toBe("closed");
  });
});
