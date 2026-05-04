// RunConversation — parallel-branch tab rendering.
//
// While there are concurrently-running branches under a parent component,
// the section for that parent collapses into a tab strip — one tab per
// active branch, filtered by branch nodeId. Once all branches complete
// (activeBranchesByParent goes empty for that parent), the tabs collapse
// back into flat node sections.

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

  it("renders one tab per active branch under a running parent component, collapses to flat list once parent completes", () => {
    const messages: RunMessageRow[] = [
      userMsg(1, "fork", "fanning out"),
      userMsg(2, "lensA", "lensA work"),
      userMsg(3, "lensB", "lensB work"),
      userMsg(4, "lensC", "lensC work"),
    ];
    const nodeStates: NodeState[] = [
      { nodeId: "fork", state: "running", lastEventSeq: 1 },
      { nodeId: "lensA", state: "running", lastEventSeq: 2 },
      { nodeId: "lensB", state: "running", lastEventSeq: 3 },
      { nodeId: "lensC", state: "running", lastEventSeq: 4 },
    ];
    const activeBranchesByParent = new Map<string, readonly string[]>([["fork", ["lensA", "lensB", "lensC"]]]);

    const { container, rerender } = renderWithClient(
      <RunConversation messages={messages} nodeStates={nodeStates} activeBranchesByParent={activeBranchesByParent} />,
    );
    const q = within(container);
    // Three tabs, one per active branch, each carrying the branchId.
    expect(q.getByTestId("branch-tab-lensA")).toBeTruthy();
    expect(q.getByTestId("branch-tab-lensB")).toBeTruthy();
    expect(q.getByTestId("branch-tab-lensC")).toBeTruthy();
    // The tabs section is named for the parent.
    expect(q.getByTestId("branch-tabs-fork")).toBeTruthy();

    // After fan_in: branches done, no active branches.
    const completedStates: NodeState[] = [
      { nodeId: "fork", state: "completed", lastEventSeq: 5 },
      { nodeId: "lensA", state: "completed", lastEventSeq: 6 },
      { nodeId: "lensB", state: "completed", lastEventSeq: 7 },
      { nodeId: "lensC", state: "completed", lastEventSeq: 8 },
    ];
    rerender(<RunConversation messages={messages} nodeStates={completedStates} activeBranchesByParent={new Map()} />);
    const q2 = within(container);
    // No tabs anymore.
    expect(q2.queryByTestId("branch-tab-lensA")).toBeNull();
    expect(q2.queryByTestId("branch-tab-lensB")).toBeNull();
    expect(q2.queryByTestId("branch-tabs-fork")).toBeNull();
    // Branches render as flat node sections.
    expect(q2.getByTestId("node-section-lensA")).toBeTruthy();
    expect(q2.getByTestId("node-section-lensB")).toBeTruthy();
    expect(q2.getByTestId("node-section-lensC")).toBeTruthy();
  });
});
