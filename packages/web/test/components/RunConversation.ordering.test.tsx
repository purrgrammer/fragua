import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function userRow(ordinal: number, nodeId: string, text: string, iteration = 0): RunMessageRow {
  return {
    ordinal,
    nodeId,
    iteration,
    content: { role: "user", content: text, timestamp: 0 },
  };
}

function sectionOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid^="node-section-"]')).map(
    (el) => el.getAttribute("data-testid") ?? "",
  );
}

describe("RunConversation — ordering", () => {
  useDom();
  afterEach(() => cleanup());

  describe("execution-order lanes", () => {
    it("slots a mid-graph HITL gate into execution order, not at the tail", () => {
      const messages: RunMessageRow[] = [
        userRow(1, "nodeA", "First node output."),
        userRow(2, "nodeC", "Third node output."),
      ];
      const nodeStates: NodeState[] = [
        { nodeId: "nodeA", iteration: 0, state: "completed", lastEventSeq: 10 },
        { nodeId: "nodeB", iteration: 0, state: "running", lastEventSeq: 20 },
        { nodeId: "nodeC", iteration: 0, state: "running", lastEventSeq: 30 },
      ];

      const { container } = renderWithClient(
        <RunConversation
          messages={messages}
          nodeStates={nodeStates}
          isPaused
          hitl={{
            runId: "run-1",
            nodeId: "nodeB",
            label: "Proceed?",
            options: ["yes", "no"],
          }}
        />,
      );

      const order = sectionOrder(container);
      const iA = order.indexOf("node-section-nodeA");
      const iB = order.indexOf("node-section-nodeB");
      const iC = order.indexOf("node-section-nodeC");

      expect(iA).toBeGreaterThanOrEqual(0);
      expect(iB).toBeGreaterThanOrEqual(0);
      expect(iC).toBeGreaterThanOrEqual(0);

      expect(iB).toBeGreaterThan(iA);
      expect(iB).toBeLessThan(iC);

      const nodeBSection = within(container).getByTestId("node-section-nodeB");
      expect(within(nodeBSection).getByTestId("hitl-step-card")).toBeTruthy();
    });

    it("renders a running tool node above a later streaming assistant section", () => {
      const nodeStates: NodeState[] = [
        { nodeId: "build", iteration: 0, state: "running", lastEventSeq: 5 },
        { nodeId: "analyze", iteration: 0, state: "running", lastEventSeq: 10 },
      ];
      const toolStreams = new Map([["build", { stdout: "compiling…\n", stderr: "" }]]);
      const streaming = {
        nodeId: "analyze",
        blocks: [{ type: "text" as const, index: 0, text: "Analyzing…" }],
      };

      const { container } = renderWithClient(
        <RunConversation
          messages={[]}
          nodeStates={nodeStates}
          toolStreams={toolStreams}
          streaming={streaming}
          isLive
        />,
      );

      const order = sectionOrder(container);
      const iBuild = order.indexOf("node-section-build");
      const iAnalyze = order.indexOf("node-section-analyze");

      expect(iBuild).toBeGreaterThanOrEqual(0);
      expect(iAnalyze).toBeGreaterThanOrEqual(0);
      expect(iBuild).toBeLessThan(iAnalyze);

      expect(within(container).getByTestId("tool-stream-build")).toBeTruthy();
      expect(within(container).getByTestId("streaming-message")).toBeTruthy();
    });

    it("renders a running tool node between an earlier completed section and a later one", () => {
      const messages: RunMessageRow[] = [
        userRow(1, "setup", "Setup complete."),
        userRow(3, "report", "Generating report."),
      ];
      const nodeStates: NodeState[] = [
        { nodeId: "setup", iteration: 0, state: "completed", lastEventSeq: 5 },
        { nodeId: "build", iteration: 0, state: "running", lastEventSeq: 10 },
        { nodeId: "report", iteration: 0, state: "running", lastEventSeq: 15 },
      ];
      const toolStreams = new Map([["build", { stdout: "building…\n", stderr: "" }]]);

      const { container } = renderWithClient(
        <RunConversation messages={messages} nodeStates={nodeStates} toolStreams={toolStreams} isLive />,
      );

      const order = sectionOrder(container);
      const iSetup = order.indexOf("node-section-setup");
      const iBuild = order.indexOf("node-section-build");
      const iReport = order.indexOf("node-section-report");

      expect(iSetup).toBeGreaterThanOrEqual(0);
      expect(iBuild).toBeGreaterThanOrEqual(0);
      expect(iReport).toBeGreaterThanOrEqual(0);

      expect(iBuild).toBeGreaterThan(iSetup);
      expect(iBuild).toBeLessThan(iReport);
    });

    it("does not append the open HITL card at the tail when its node sits mid-graph", () => {
      const messages: RunMessageRow[] = [userRow(1, "fetch", "Fetched data."), userRow(2, "apply", "Applied changes.")];
      const nodeStates: NodeState[] = [
        { nodeId: "fetch", iteration: 0, state: "completed", lastEventSeq: 10 },
        { nodeId: "review", iteration: 0, state: "running", lastEventSeq: 20 },
        { nodeId: "apply", iteration: 0, state: "running", lastEventSeq: 30 },
      ];

      const { container } = renderWithClient(
        <RunConversation
          messages={messages}
          nodeStates={nodeStates}
          isPaused
          hitl={{
            runId: "run-1",
            nodeId: "review",
            label: "Approve?",
            options: ["yes", "no"],
          }}
        />,
      );

      const order = sectionOrder(container);
      const iFetch = order.indexOf("node-section-fetch");
      const iReview = order.indexOf("node-section-review");
      const iApply = order.indexOf("node-section-apply");

      expect(iReview).toBeGreaterThan(iFetch);
      expect(iReview).toBeLessThan(iApply);
    });
  });

  describe("looped nodes", () => {
    it("aligns two iterations of the same node to per-iteration nodeStates while preserving ordinal order", () => {
      const messages: RunMessageRow[] = [
        userRow(1, "loop", "Iteration 0 output.", 0),
        userRow(2, "other", "Other node output.", 0),
        userRow(3, "loop", "Iteration 1 output.", 1),
      ];
      const nodeStates: NodeState[] = [
        { nodeId: "loop", iteration: 0, state: "completed", lastEventSeq: 10 },
        { nodeId: "other", iteration: 0, state: "completed", lastEventSeq: 20 },
        { nodeId: "loop", iteration: 1, state: "completed", lastEventSeq: 30 },
      ];

      const { container } = renderWithClient(<RunConversation messages={messages} nodeStates={nodeStates} />);

      const sections = Array.from(container.querySelectorAll('[data-testid^="node-section-"]'));
      expect(sections.length).toBe(3);

      const testids = sections.map((el) => el.getAttribute("data-testid"));
      expect(testids[0]).toBe("node-section-loop");
      expect(testids[1]).toBe("node-section-other");
      expect(testids[2]).toBe("node-section-loop");

      expect(sections[0]?.textContent).toContain("Iteration 0 output.");
      expect(sections[2]?.textContent).toContain("Iteration 1 output.");
    });

    it("keeps a retry-loop node's two runs in ordinal order when nodeState collapses them (ci→fix→ci)", () => {
      const messages: RunMessageRow[] = [
        userRow(1, "ci", "CI run 1 (failed)."),
        userRow(2, "fix", "Applying fix."),
        userRow(3, "ci", "CI run 2 (passed)."),
      ];
      // The ci↔fix retry loop reuses iteration 0, so nodeStates carries ONE
      // collapsed `ci` entry whose lastEventSeq is its LAST event — AFTER
      // fix. Ordering sections by that seq would drag the first ci run down
      // next to the second ("two ci steps at the end"); ordinal order must win.
      const nodeStates: NodeState[] = [
        { nodeId: "ci", iteration: 0, state: "completed", lastEventSeq: 30 },
        { nodeId: "fix", iteration: 0, state: "completed", lastEventSeq: 20 },
      ];

      const { container } = renderWithClient(<RunConversation messages={messages} nodeStates={nodeStates} />);

      const testids = sectionOrder(container);
      expect(testids).toEqual(["node-section-ci", "node-section-fix", "node-section-ci"]);

      const sections = Array.from(container.querySelectorAll('[data-testid^="node-section-"]'));
      expect(sections[0]?.textContent).toContain("CI run 1");
      expect(sections[2]?.textContent).toContain("CI run 2");
    });
  });
});
