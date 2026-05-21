// RunConversation — HITL step card rendering.
//
// When a run is paused at a human gate (paused_human), RunConversation
// renders an inline HitlStepCard at the tail of the paused node's
// section. The card shows the question text, one button per route, and
// a notes textarea. When the paused node has no messages yet (the human
// node is the first/only step), an orphan section is synthesised.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function userRow(ordinal: number, nodeId: string, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

describe("RunConversation — HITL step card", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders HitlStepCard at the tail of the matching node section", () => {
    const messages: RunMessageRow[] = [userRow(1, "review", "Please review the diff.")];
    const nodeStates: NodeState[] = [{ nodeId: "review", iteration: 0, state: "running", lastEventSeq: 1 }];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        isPaused
        hitl={{
          runId: "run-42",
          nodeId: "review",
          label: "Approve or reject?",
          options: ["approve", "reject"],
        }}
      />,
    );

    const section = within(container).getByTestId("node-section-review");
    expect(section).toBeTruthy();

    const card = within(section).getByTestId("hitl-step-card");
    expect(card).toBeTruthy();

    // Question text is visible.
    expect(within(card).getByTestId("hitl-step-label").textContent).toBe("Approve or reject?");

    // One button per route.
    const optionsDiv = within(card).getByTestId("hitl-step-options");
    expect(within(optionsDiv).getByTestId("hitl-step-approve")).toBeTruthy();
    expect(within(optionsDiv).getByTestId("hitl-step-reject")).toBeTruthy();

    // Notes textarea is present.
    expect(within(card).getByTestId("hitl-step-note")).toBeTruthy();
  });

  it("synthesises an orphan node section when the paused node has no messages", () => {
    const nodeStates: NodeState[] = [{ nodeId: "gate", iteration: 0, state: "running", lastEventSeq: 2 }];

    const { container } = renderWithClient(
      <RunConversation
        messages={[]}
        nodeStates={nodeStates}
        isPaused
        hitl={{
          runId: "run-99",
          nodeId: "gate",
          label: "Proceed?",
          options: ["yes", "no"],
        }}
      />,
    );

    // A section is synthesised for the paused node even with no messages.
    const section = within(container).getByTestId("node-section-gate");
    expect(section).toBeTruthy();

    const card = within(section).getByTestId("hitl-step-card");
    expect(card).toBeTruthy();
    expect(within(card).getByTestId("hitl-step-label").textContent).toBe("Proceed?");
    expect(within(card).getByTestId("hitl-step-yes")).toBeTruthy();
    expect(within(card).getByTestId("hitl-step-no")).toBeTruthy();
  });

  it("does not render the card when hitl prop is null", () => {
    const messages: RunMessageRow[] = [userRow(1, "review", "Check this.")];

    const { container } = renderWithClient(<RunConversation messages={messages} hitl={null} />);

    expect(container.querySelector('[data-testid="hitl-step-card"]')).toBeNull();
  });

  it("does not render the card when hitl options are empty (no routes declared)", () => {
    const messages: RunMessageRow[] = [userRow(1, "review", "Check this.")];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        isPaused
        hitl={{
          runId: "run-1",
          nodeId: "review",
          label: "Waiting…",
          options: [],
        }}
      />,
    );

    expect(container.querySelector('[data-testid="hitl-step-card"]')).toBeNull();
  });

  it("renders the card inside the correct section when multiple node sections exist", () => {
    const messages: RunMessageRow[] = [
      userRow(1, "fetch", "Fetching data."),
      userRow(2, "review", "Here is the data."),
    ];
    const nodeStates: NodeState[] = [
      { nodeId: "fetch", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "review", iteration: 0, state: "running", lastEventSeq: 2 },
    ];

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        isPaused
        hitl={{
          runId: "run-7",
          nodeId: "review",
          label: "Looks good?",
          options: ["yes", "no"],
        }}
      />,
    );

    const fetchSection = within(container).getByTestId("node-section-fetch");
    const reviewSection = within(container).getByTestId("node-section-review");

    // Card is inside review section only.
    expect(within(reviewSection).getByTestId("hitl-step-card")).toBeTruthy();
    expect(within(fetchSection).queryByTestId("hitl-step-card")).toBeNull();
  });

  it("renders humanized route labels on the buttons", () => {
    const { container } = renderWithClient(
      <RunConversation
        messages={[]}
        isPaused
        hitl={{
          runId: "run-1",
          nodeId: "approve_step",
          label: null,
          options: ["needs_more_info", "looks_good"],
        }}
      />,
    );

    const card = within(container).getByTestId("hitl-step-card");
    const text = card.textContent ?? "";
    expect(text).toContain("Needs More Info");
    expect(text).toContain("Looks Good");
  });

  it("does not render label element when label is null", () => {
    const { container } = renderWithClient(
      <RunConversation
        messages={[]}
        isPaused
        hitl={{
          runId: "run-1",
          nodeId: "gate",
          label: null,
          options: ["continue"],
        }}
      />,
    );

    const card = within(container).getByTestId("hitl-step-card");
    expect(within(card).queryByTestId("hitl-step-label")).toBeNull();
  });
});
