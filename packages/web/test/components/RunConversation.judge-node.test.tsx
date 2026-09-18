// RunConversation — judge_node row rendering.
//
// A `type: judge` step persists a `role:"judge_node"` row carrying the
// questions asked, the typed answers, and the `decide:` result. It renders
// as one row per question plus a decision line; no transcript, no terminal.

import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

function judgeRow(
  decision?:
    | { kind: "route"; route: string; belowThreshold: boolean }
    | { kind: "outcome"; status: "success" | "fail" },
): RunMessageRow {
  return {
    ordinal: 1,
    nodeId: "triage",
    iteration: 0,
    content: {
      role: "judge_node",
      provider: "typesafe",
      model: "jev-1.13.0",
      statePreview: '{"goal":"fix the flaky test"}',
      stateBytes: 205,
      questions: {
        next_step: { type: "choice", instructions: "Decide the next step." },
        goal_met: { type: "noul", instructions: "Is the goal met?" },
        risk: { type: "score", instructions: "Rate the risk." },
      },
      answers: {
        next_step: {
          type: "choice",
          choice: "revise",
          confidence: 0.98,
          probabilities: { accept: 0.01, revise: 0.99, escalate: 0 },
        },
        goal_met: { type: "noul", noul: 0.2 },
        risk: {
          type: "score",
          score: 0,
          confidence: 1,
          legend: { "0": "trivial", "1": "moderate", "2": "high" },
          probabilities: { "0": 1, "1": 0, "2": 0 },
        },
      },
      ...(decision !== undefined ? { decision } : {}),
      durationMs: 687,
      timestamp: 0,
    },
  };
}

describe("RunConversation — judge_node row", () => {
  afterEach(() => cleanup());

  it("shows each question's text, every option as a bar with the chosen one first, and the route decision", () => {
    const nodeStates: NodeState[] = [{ nodeId: "triage", iteration: 0, state: "completed", lastEventSeq: 1 }];
    const { container } = renderWithClient(
      <RunConversation
        messages={[judgeRow({ kind: "route", route: "revise", belowThreshold: false })]}
        nodeStates={nodeStates}
      />,
    );
    const q = within(container);
    const row = q.getByTestId("message-1");
    expect(row.textContent).toContain("jev-1.13.0");
    expect(row.textContent).toContain("Decide the next step.");
    expect(row.textContent).toContain("confidence 0.98");
    // choice options sorted by probability, chosen first
    const labels = Array.from(row.querySelectorAll("[data-option-label]")).map((el) => el.textContent);
    expect(labels.slice(0, 3)).toEqual(["revise", "accept", "escalate"]);
    // noul renders as yes / no
    expect(row.textContent).toContain("yes");
    expect(row.textContent).toContain("0.20");
    // score renders legend labels when present
    expect(row.textContent).toContain("0 · trivial");
    expect(row.textContent).toContain("routed to revise");
    expect(row.textContent).not.toContain("confidence floor");
    expect(q.queryByTestId("terminal")).toBeNull();
  });

  it("names the below-threshold landing and an outcome fail", () => {
    const below = renderWithClient(
      <RunConversation messages={[judgeRow({ kind: "route", route: "unsure", belowThreshold: true })]} />,
    );
    expect(below.container.textContent).toContain(
      "routed to unsure — the chosen option was below the confidence floor",
    );
    cleanup();
    const failed = renderWithClient(<RunConversation messages={[judgeRow({ kind: "outcome", status: "fail" })]} />);
    expect(failed.container.textContent).toContain("gate failed — outcome fail");
  });

  it("a decide-less judge renders answers with no decision line", () => {
    const { container } = renderWithClient(<RunConversation messages={[judgeRow()]} />);
    expect(container.textContent).toContain("yes");
    expect(container.textContent).not.toContain("routed to");
    expect(container.textContent).not.toContain("gate ");
  });
});

describe("RunConversation — judge_node for-each row", () => {
  afterEach(() => cleanup());

  it("groups the expanded answers per item and names kept / dropped", () => {
    const row: RunMessageRow = {
      ordinal: 1,
      nodeId: "correctness_judge",
      iteration: 0,
      content: {
        role: "judge_node",
        provider: "typesafe",
        model: "jev-1.13.0",
        statePreview: '{"items":[…]}',
        stateBytes: 900,
        questions: { holds: { type: "noul", instructions: "Does `item.cited_code` show `item.claim`?" } },
        answers: {
          holds__0: { type: "noul", noul: 0.91 },
          holds__1: { type: "noul", noul: 0.2 },
        },
        forEach: { count: 2, chunks: 1, kept: [0] },
        durationMs: 800,
        timestamp: 0,
      },
    };
    const nodeStates: NodeState[] = [
      { nodeId: "correctness_judge", iteration: 0, state: "completed", lastEventSeq: 1 },
    ];
    const { container } = renderWithClient(<RunConversation messages={[row]} nodeStates={nodeStates} />);
    const items = Array.from(within(container).getByTestId("message-1").querySelectorAll("[data-testid='judge-item']"));
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute("data-verdict")).toBe("kept");
    expect(items[0]!.textContent).toContain("item 0");
    expect(items[0]!.textContent).toContain("0.91");
    expect(items[1]!.getAttribute("data-verdict")).toBe("dropped");
    expect(items[1]!.textContent).toContain("0.20");
  });
});
