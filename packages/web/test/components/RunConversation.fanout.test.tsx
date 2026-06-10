// RunConversation — fan-out (`type: parallel`) branch grouping.
//
// Concurrent branches interleave their messages on the wire; rather than
// render them as N alternating sections, RunConversation collapses each
// parent's branch run into one parallel group whose branches are each a
// collapsed-by-default Collapsible. Streaming buffers are keyed per node
// so a branch shows its OWN in-flight output, never a sibling's.

import { cleanup, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunDetail, RunMessageRow } from "../../src/lib/api.ts";
import type { StreamingMessage } from "../../src/lib/useRunLive.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

// Server-derived `RunDetail.fanout` records for a `scope → review(parallel:
// [lens_a, lens_b]) → synth` workflow: each branch closure is just its entry,
// parented under `review` in declared order.
const FANOUT: NonNullable<RunDetail["fanout"]> = {
  parentOf: { lens_a: "review", lens_b: "review" },
  branchOf: { lens_a: "lens_a", lens_b: "lens_b" },
  orderOf: { lens_a: 0, lens_b: 1 },
  nodeTypes: {
    start: "start",
    scope: "llm",
    review: "parallel",
    lens_a: "llm",
    lens_b: "llm",
    synth: "llm",
    exit: "exit",
  },
};

function assistantRow(ordinal: number, nodeId: string, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId,
    iteration: 0,
    content: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as RunMessageRow["content"],
  };
}

describe("RunConversation — fan-out branch grouping", () => {
  afterEach(() => cleanup());

  it("collapses interleaved branch sections into one parallel group with a collapsible per branch", () => {
    // Messages arrive interleaved (lens_a, lens_b, lens_a, lens_b) — the
    // shape a real concurrent fan-out produces.
    const messages: RunMessageRow[] = [
      assistantRow(1, "lens_a", "A first"),
      assistantRow(2, "lens_b", "B first"),
      assistantRow(3, "lens_a", "A second"),
      assistantRow(4, "lens_b", "B second"),
    ];
    const nodeStates: NodeState[] = [
      { nodeId: "lens_a", iteration: 0, state: "completed", lastEventSeq: 3 },
      { nodeId: "lens_b", iteration: 0, state: "running", lastEventSeq: 4 },
    ];

    const { container } = renderWithClient(
      <RunConversation messages={messages} nodeStates={nodeStates} fanout={FANOUT} isLive />,
    );
    const q = within(container);

    // One parallel group for the `review` parent — NOT four interleaved sections.
    expect(q.getByTestId("parallel-section-review")).toBeTruthy();
    expect(q.queryByTestId("node-section-lens_a")).toBeNull();

    // Each branch is its own collapsible, collapsed by default (content not
    // mounted until expanded).
    const branchA = q.getByTestId("branch-lens_a");
    const branchB = q.getByTestId("branch-lens_b");
    expect(within(branchA).queryByText("A first")).toBeNull();

    // Expand branch A → its two interleaved sections are merged under it, and
    // branch B's messages never leak in.
    fireEvent.click(within(branchA).getByRole("button"));
    expect(within(branchA).getByText("A first")).toBeTruthy();
    expect(within(branchA).getByText("A second")).toBeTruthy();
    expect(within(branchA).queryByText("B first")).toBeNull();

    fireEvent.click(within(branchB).getByRole("button"));
    expect(within(branchB).getByText("B first")).toBeTruthy();
    expect(within(branchB).getByText("B second")).toBeTruthy();
  });

  it("renders each branch's OWN streaming buffer, not a shared one", () => {
    const messages: RunMessageRow[] = [];
    const nodeStates: NodeState[] = [
      { nodeId: "lens_a", iteration: 0, state: "running", lastEventSeq: 1 },
      { nodeId: "lens_b", iteration: 0, state: "running", lastEventSeq: 2 },
    ];
    const streamingByNode = new Map<string, StreamingMessage>([
      ["lens_a", { nodeId: "lens_a", blocks: [{ type: "text", index: 0, text: "alpha streaming" }] }],
      ["lens_b", { nodeId: "lens_b", blocks: [{ type: "text", index: 0, text: "beta streaming" }] }],
    ]);

    const { container } = renderWithClient(
      <RunConversation
        messages={messages}
        nodeStates={nodeStates}
        streamingByNode={streamingByNode}
        fanout={FANOUT}
        isLive
      />,
    );
    const q = within(container);

    // Fan-out with no persisted rows yet still surfaces a parallel group
    // (not an empty conversation), each branch streaming independently.
    const branchAEl = q.getByTestId("branch-lens_a");
    const branchBEl = q.getByTestId("branch-lens_b");

    fireEvent.click(within(branchAEl).getByRole("button"));
    fireEvent.click(within(branchBEl).getByRole("button"));
    expect(within(branchAEl).getByText("alpha streaming")).toBeTruthy();
    expect(within(branchBEl).getByText("beta streaming")).toBeTruthy();
    // No cross-contamination: alpha text does not appear under branch B.
    expect(within(branchBEl).queryByText("alpha streaming")).toBeNull();
  });
});
