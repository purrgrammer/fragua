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
        risk: { type: "score", score: 0, confidence: 1, legend: {}, probabilities: { "0": 1, "1": 0, "2": 0 } },
      },
      ...(decision !== undefined ? { decision } : {}),
      durationMs: 687,
      timestamp: 0,
    },
  };
}

describe("RunConversation — judge_node row", () => {
  afterEach(() => cleanup());

  it("renders one row per question with the typed answer, and the route decision", () => {
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
    expect(row.textContent).toContain("next_step");
    expect(row.textContent).toContain("revise — conf 0.98");
    expect(row.textContent).toContain("revise 0.99");
    expect(row.textContent).toContain("goal_met");
    expect(row.textContent).toContain("p(yes) 0.20");
    expect(row.textContent).toContain("score 0.00");
    expect(row.textContent).toContain("route revise");
    expect(row.textContent).not.toContain("below confidence floor");
    expect(q.queryByTestId("terminal")).toBeNull();
  });

  it("names the below-threshold landing and an outcome fail", () => {
    const below = renderWithClient(
      <RunConversation messages={[judgeRow({ kind: "route", route: "unsure", belowThreshold: true })]} />,
    );
    expect(below.container.textContent).toContain("route unsure (below confidence floor)");
    cleanup();
    const failed = renderWithClient(<RunConversation messages={[judgeRow({ kind: "outcome", status: "fail" })]} />);
    expect(failed.container.textContent).toContain("outcome fail");
  });

  it("a decide-less judge renders answers with no decision line", () => {
    const { container } = renderWithClient(<RunConversation messages={[judgeRow()]} />);
    expect(container.textContent).toContain("p(yes) 0.20");
    expect(container.textContent).not.toContain("route ");
    expect(container.textContent).not.toContain("outcome ");
  });
});
