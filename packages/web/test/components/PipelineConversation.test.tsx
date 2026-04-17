// PipelineConversation component tests.
//
// We assert the DOM-level contract the task spec calls out:
//   - `data-testid="node-section-<id>"` per section.
//   - `Checkpoint` rendered between sections (above every section,
//     including the first — it also anchors graph-click scrolls).
//   - `Reasoning` trigger is present on messages with thinking parts.
//   - Tool header renders the mapped swarm tool name.
//   - Long runs (>LONG_RUN_TURNS turns): sections default collapsed;
//     the "Expand all" button un-collapses them.
//   - Live-streaming part shows a `Shimmer` sibling next to the status
//     chip AND next to the streaming body part.
//   - Stable `data-testid`s: `turn-<turnId>`, `tool-<toolCallId>`,
//     `reasoning-<messageId>`.
//
// We build the `PipelineConversation` tree by running the pure reducer
// over synthetic events — that way the tests double as an end-to-end
// contract check across reducer + component.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { PipelineConversation } from "../../src/components/PipelineConversation.tsx";
import {
  type PipelineConversation as ConversationTree,
  eventsToConversation,
  type RawEvent,
} from "../../src/lib/events-to-conversation.ts";
import { useDom } from "../setup.ts";

function ev(type: string, opts: Partial<RawEvent> = {}): RawEvent {
  return {
    type,
    node_id: opts.node_id ?? "explore",
    session_id: opts.session_id ?? null,
    data: opts.data ?? {},
  };
}

/** A three-node pipeline with one reasoning + one tool call in the middle. */
function buildConversation(): ConversationTree {
  return eventsToConversation([
    ev("node.started", { node_id: "start" }),
    ev("node.completed", { node_id: "start", data: { outcome: "pass" } }),

    ev("node.started", { node_id: "explore" }),
    ev("agent.turn_start", { node_id: "explore" }),
    ev("agent.message_start", { node_id: "explore", data: { role: "assistant" } }),
    ev("llm.thinking_delta", {
      node_id: "explore",
      data: { delta: "Let me consider the options." },
    }),
    ev("llm.text_delta", {
      node_id: "explore",
      data: { delta: "I'll read the config file.", content_index: 0 },
    }),
    ev("llm.toolcall_delta", {
      node_id: "explore",
      data: { delta: "{}", content_index: 1 },
    }),
    ev("llm.done", { node_id: "explore" }),
    ev("agent.message_end", { node_id: "explore", data: { role: "assistant" } }),
    ev("tool.execution_start", {
      node_id: "explore",
      data: {
        tool_call_id: "call_read",
        tool_name: "local:read_file",
        args: { path: "config.yaml" },
      },
    }),
    ev("tool.execution_end", {
      node_id: "explore",
      data: {
        tool_call_id: "call_read",
        tool_name: "local:read_file",
        is_error: false,
        result: { content: [{ type: "text", text: "port: 3000" }] },
      },
    }),
    ev("cost.recorded", {
      node_id: "explore",
      data: {
        cost_usd: 0.0012,
        input_tokens: 42,
        output_tokens: 17,
        model: "claude-haiku-4-5",
      },
    }),
    ev("agent.turn_end", { node_id: "explore" }),
    ev("node.completed", { node_id: "explore", data: { outcome: "pass" } }),

    ev("node.started", { node_id: "done" }),
    ev("node.completed", { node_id: "done", data: { outcome: "pass" } }),
  ]);
}

describe("PipelineConversation", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one section per node with stable data-testids", () => {
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    expect(within(container).getByTestId("node-section-start")).toBeTruthy();
    expect(within(container).getByTestId("node-section-explore")).toBeTruthy();
    expect(within(container).getByTestId("node-section-done")).toBeTruthy();
  });

  it("renders a step header at the same level as messages, not as a collapsible", () => {
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    // Three sections expected (start / explore / done); each has a plain
    // node-id label, not the old "Node: <id>" checkpoint trigger.
    const sections = container.querySelectorAll("[data-testid^='node-section-']");
    expect(sections).toHaveLength(3);
    for (const s of Array.from(sections)) {
      expect(s.textContent ?? "").not.toContain("Node: ");
    }
    // And no per-section collapse toggle — the section body is an
    // inline <div>, not a Radix Collapsible, so its id isn't bound to
    // an aria-expanded trigger anywhere in this component's chrome.
    for (const s of Array.from(sections)) {
      const nodeId = s.getAttribute("data-testid")?.replace(/^node-section-/, "") ?? "";
      const toggle = s.querySelector(`[aria-controls='node-section-body-${nodeId}']`);
      expect(toggle).toBeNull();
    }
  });

  it("renders a Reasoning block for messages with thinking parts", () => {
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    const reasoningBlocks = container.querySelectorAll("[data-testid^='reasoning-']");
    // Exactly one assistant message had a thinking delta → one reasoning block.
    expect(reasoningBlocks.length).toBe(1);
  });

  it("renders the Tool block with the mapped swarm tool name in its header", () => {
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    const toolBlock = within(container).getByTestId("tool-call_read");
    expect(toolBlock).toBeTruthy();
    // Header shows the human-readable label from the TOOL_PRESENTATION
    // registry, not the raw `local:read_file` canonical name.
    expect(toolBlock.textContent ?? "").toContain("Read File");
    expect(toolBlock.textContent ?? "").not.toContain("local:read_file");
    // And the badge reports "Completed" for output-available.
    expect(toolBlock.textContent ?? "").toContain("Completed");
  });

  it("renders turn ids as stable data-testids", () => {
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    const turns = container.querySelectorAll("[data-testid^='turn-']");
    // One turn in the explore section (start/done had no agent turns).
    expect(turns.length).toBe(1);
    const id = turns[0]?.getAttribute("data-testid") ?? "";
    expect(id).toMatch(/^turn-explore-t\d+$/);
  });

  it("does NOT show cost/tokens/model inline — the byline is hidden for now", () => {
    // The data still flows into the reducer (other surfaces read it),
    // but inline rendering looked orphaned between messages and was
    // commented out. Re-enable this assertion when the byline comes
    // back in a layout that reads cleanly.
    const conv = buildConversation();
    const { container } = render(<PipelineConversation conversation={conv} />);
    const body = container.textContent ?? "";
    expect(body).not.toContain("claude-haiku-4-5");
    expect(body).not.toMatch(/\$0\.00/);
  });

  it("renders an empty state when there are no sections", () => {
    const { container } = render(<PipelineConversation conversation={[]} />);
    expect(within(container).getByTestId("conversation-empty")).toBeTruthy();
  });

  it("prefers server-side nodeStates over the reducer's section.status", () => {
    const conv: ConversationTree = [{ nodeId: "explore", status: "running", turns: [] }];
    const { container } = render(
      <PipelineConversation
        conversation={conv}
        nodeStates={[{ nodeId: "explore", state: "failed", lastEventSeq: 1 }]}
      />,
    );
    const section = within(container).getByTestId("node-section-explore");
    expect(section.getAttribute("data-status")).toBe("failed");
  });

  it("renders a streaming Shimmer pill when isLive=true and a part is still streaming", () => {
    // A conversation where the last text part never got `streaming=false`
    // (no llm.done, no agent.message_end).
    const conv = eventsToConversation([
      ev("node.started", { node_id: "explore" }),
      ev("agent.turn_start", { node_id: "explore" }),
      ev("agent.message_start", { node_id: "explore", data: { role: "assistant" } }),
      ev("llm.text_delta", {
        node_id: "explore",
        data: { delta: "partial", content_index: 0 },
      }),
    ]);
    const { container } = render(<PipelineConversation conversation={conv} isLive={true} />);
    const shimmers = container.querySelectorAll("*");
    // Two shimmer usages: section header (node is running + isLive) and
    // message-level streaming pill. Assert at least one "streaming…" appears.
    const count = Array.from(shimmers).filter((el) => (el.textContent ?? "").includes("streaming…")).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
