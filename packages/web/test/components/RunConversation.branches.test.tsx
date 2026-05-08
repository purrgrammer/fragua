// RunConversation — parallel-branch stack rendering.
//
// Branches under a parallel parent render as a vertical stack of
// collapsible cards (same shape as the `agent` toolCall card). Every
// branch's nodeId + status + message count is visible at a glance;
// click-to-expand reveals the transcript. The in-flight branch
// (running or streaming) defaults to open; the rest stay collapsed.
// A `fan_in summary` footer card surfaces the join's winner +
// ranked order so heuristic fan_in nodes (no LLM messages) still
// communicate their conclusion.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function userMsg(ordinal: number, nodeId: string | null, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

describe("RunConversation — parallel branches", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one collapsible card per branch under a parent component, tracking branch state, and keeps the cards after every branch completes", () => {
    const messages: RunMessageRow[] = [
      userMsg(1, "fork", "fanning out"),
      userMsg(2, "lensA", "lensA work"),
      userMsg(3, "lensB", "lensB work"),
      userMsg(4, "lensC", "lensC work"),
    ];
    const nodeStates: NodeState[] = [
      { nodeId: "fork", iteration: 0, state: "running", lastEventSeq: 1 },
      { nodeId: "lensA", iteration: 0, state: "running", lastEventSeq: 2 },
      { nodeId: "lensB", iteration: 0, state: "running", lastEventSeq: 3 },
      { nodeId: "lensC", iteration: 0, state: "running", lastEventSeq: 4 },
    ];
    const branchesByParent = new Map<string, readonly string[]>([["fork", ["lensA", "lensB", "lensC"]]]);

    const { container, rerender } = renderWithClient(
      <RunConversation messages={messages} nodeStates={nodeStates} branchesByParent={branchesByParent} />,
    );
    const q = within(container);
    expect(q.getByTestId("branch-tabs-fork")).toBeTruthy();
    // Three cards, one per branch, each carrying live state.
    expect(q.getByTestId("branch-card-lensA").getAttribute("data-branch-state")).toBe("running");
    expect(q.getByTestId("branch-card-lensB").getAttribute("data-branch-state")).toBe("running");
    expect(q.getByTestId("branch-card-lensC").getAttribute("data-branch-state")).toBe("running");

    // After fan_in: every branch completes. Cards persist; status flips
    // to `completed` so the stack still communicates structure + outcome
    // on a finished run (no info hidden behind tab interaction).
    const completedStates: NodeState[] = [
      { nodeId: "fork", iteration: 0, state: "completed", lastEventSeq: 5 },
      { nodeId: "lensA", iteration: 0, state: "completed", lastEventSeq: 6 },
      { nodeId: "lensB", iteration: 0, state: "completed", lastEventSeq: 7 },
      { nodeId: "lensC", iteration: 0, state: "completed", lastEventSeq: 8 },
    ];
    rerender(<RunConversation messages={messages} nodeStates={completedStates} branchesByParent={branchesByParent} />);
    const q2 = within(container);
    expect(q2.getByTestId("branch-tabs-fork")).toBeTruthy();
    expect(q2.getByTestId("branch-card-lensA").getAttribute("data-branch-state")).toBe("completed");
    expect(q2.getByTestId("branch-card-lensB").getAttribute("data-branch-state")).toBe("completed");
    expect(q2.getByTestId("branch-card-lensC").getAttribute("data-branch-state")).toBe("completed");
  });

  it("renders cards even when the parent component never produced its own messages (parallel handler with no LLM step)", () => {
    // The `parallel` handler opens no LLM call of its own — there's no
    // section for `fanout`. Branch sections should still fold into a
    // stack via `findParentForBranch` so the structure stays visible.
    const messages: RunMessageRow[] = [
      userMsg(1, "drift", "drift work"),
      userMsg(2, "plugin_validate", "validation log"),
    ];
    const nodeStates: NodeState[] = [
      { nodeId: "fanout", iteration: 0, state: "completed", lastEventSeq: 3 },
      { nodeId: "drift", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "plugin_validate", iteration: 0, state: "completed", lastEventSeq: 2 },
    ];
    const branchesByParent = new Map<string, readonly string[]>([["fanout", ["drift", "plugin_validate"]]]);
    const { container } = renderWithClient(
      <RunConversation messages={messages} nodeStates={nodeStates} branchesByParent={branchesByParent} />,
    );
    const q = within(container);
    expect(q.getByTestId("branch-tabs-fanout")).toBeTruthy();
    expect(q.getByTestId("branch-card-drift")).toBeTruthy();
    expect(q.getByTestId("branch-card-plugin_validate")).toBeTruthy();
  });

  it("renders a fan_in summary card under the branch stack with winner + ranked order", () => {
    // Heuristic fan_in (or any fan_in that doesn't open an LLM call)
    // produces no transcript messages. Without a summary card the
    // operator has no record of which branch the join picked.
    const messages: RunMessageRow[] = [userMsg(1, "drift", "drift work")];
    const nodeStates: NodeState[] = [
      { nodeId: "fanout", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "drift", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "plugin_validate", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "verdict", iteration: 0, state: "completed", lastEventSeq: 1 },
    ];
    const branchesByParent = new Map<string, readonly string[]>([["fanout", ["drift", "plugin_validate"]]]);
    const fanInResultsByParent = new Map<string, import("../../src/lib/branch-meta").FanInResult>([
      [
        "fanout",
        {
          nodeId: "verdict",
          winner: "drift",
          rankedOrder: ["drift", "plugin_validate"],
          allFailed: false,
        },
      ],
    ]);
    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        branchesByParent={branchesByParent}
        fanInResultsByParent={fanInResultsByParent}
      />,
    );
    const q = within(container);
    const summary = q.getByTestId("fan-in-summary-fanout");
    expect(summary).toBeTruthy();
    expect(summary.getAttribute("data-fan-in-node")).toBe("verdict");
    expect(summary.textContent).toMatch(/verdict/);
    expect(summary.textContent).toMatch(/drift/);
    expect(summary.textContent).toMatch(/plugin_validate/);
  });
});
