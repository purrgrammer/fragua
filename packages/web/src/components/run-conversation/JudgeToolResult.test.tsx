import type { ToolResultMessage } from "@fragua/types";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { JudgeToolResult } from "./JudgeToolResult.tsx";

function okResult(answers: Record<string, unknown>): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "judge",
    content: [{ type: "text", text: JSON.stringify(answers) }],
    details: {
      fragua_tool: "judge",
      is_error: false,
      data: { model: "jev-1.13.0", answers, input_tokens: 1234, cost_usd: 0.0000518 },
      truncated: false,
      original_length: 0,
    },
    isError: false,
    timestamp: 0,
  };
}

const params = {
  state: {
    claim: "halt(...) is returned for 401/403",
    findings: [{ cited_code: "if (status === 401) return halt(...)\n".repeat(6), path: "judge.ts:88" }],
  },
  questions: {
    holds: { type: "noul", instructions: "Does `findings[0].cited_code` support `claim`?" },
    severity: {
      type: "score",
      instructions: "How severe is the finding?",
      criteria: ["low — cosmetic", "medium — contained", "high — will trigger"],
    },
    kind: {
      type: "choice",
      instructions: "What kind of change is this?",
      criteria: { bug: "a defect", feature: "new behaviour" },
    },
  },
};

describe("JudgeToolResult", () => {
  afterEach(() => cleanup());

  test("renders the state tree with long text as its own block", () => {
    render(<JudgeToolResult params={params} result={undefined} />);
    const state = screen.getByTestId("judge-tool-state");
    expect(state.textContent).toContain("claim");
    expect(state.textContent).toContain("halt(...) is returned for 401/403");
    expect(within(state).getByText("cited_code")).toBeTruthy();
    expect(within(state).getAllByTestId("judge-tool-text")).toHaveLength(1);
  });

  test("before the answer lands each question shows its criteria and awaits", () => {
    render(<JudgeToolResult params={params} result={undefined} />);
    const blocks = screen.getAllByTestId("judge-question");
    expect(blocks).toHaveLength(3);
    expect(screen.getAllByText("awaiting answer")).toHaveLength(3);
    expect(blocks[1]!.textContent).toContain("medium — contained");
    expect(blocks[2]!.textContent).toContain("new behaviour");
  });

  test("with answers every question renders probability bars, the torn ones are named, and the meta line shows cost", () => {
    render(
      <JudgeToolResult
        params={params}
        result={okResult({
          holds: { type: "noul", noul: 0.91 },
          severity: {
            type: "score",
            score: 1.56,
            confidence: 0.5,
            legend: { "0": "low — cosmetic", "1": "medium — contained", "2": "high — will trigger" },
            probabilities: { "0": 0.03, "1": 0.47, "2": 0.5 },
          },
          kind: { type: "choice", choice: "bug", confidence: 0.45, probabilities: { bug: 0.55, feature: 0.45 } },
        })}
      />,
    );
    const [holds, severity, kind] = screen.getAllByTestId("judge-question");
    const labels = (el: HTMLElement) => [...el.querySelectorAll("[data-option-label]")].map((n) => n.textContent);
    expect(labels(holds!)).toEqual(["yes", "no"]);
    expect(holds!.textContent).toContain("0.91");
    expect(holds!.textContent).not.toContain("undecided");
    expect(labels(severity!)).toEqual(["0 · low — cosmetic", "1 · medium — contained", "2 · high — will trigger"]);
    expect(severity!.textContent).toContain("confidence 0.50");
    expect(labels(kind!)).toEqual(["bug", "feature"]);
    expect(kind!.textContent).toContain("undecided");
    expect(screen.getByText(/jev-1\.13\.0 · 1,234 input tokens · \$0\.0001/)).toBeTruthy();
    expect(screen.queryByText("awaiting answer")).toBeNull();
  });

  test("an error result keeps the state and questions and names the error", () => {
    const err: ToolResultMessage = {
      ...okResult({}),
      content: [
        {
          type: "text",
          text: "judge provider error (400): max_tokens_exceeded — the state is over the provider's input cap",
        },
      ],
      details: { fragua_tool: "judge", is_error: true, data: undefined, truncated: false, original_length: 0 },
      isError: true,
    };
    render(<JudgeToolResult params={params} result={err} />);
    expect(screen.getByTestId("judge-tool-error").textContent).toContain("max_tokens_exceeded");
    expect(screen.getAllByTestId("judge-question")).toHaveLength(3);
    expect(screen.getAllByText("no answer")).toHaveLength(3);
  });

  test("a string state that encodes JSON renders as the tree it encodes", () => {
    render(
      <JudgeToolResult
        params={{ state: JSON.stringify({ findings: [{ id: "a", claim: "b" }] }), questions: {} }}
        result={undefined}
      />,
    );
    const state = screen.getByTestId("judge-tool-state");
    expect(within(state).getByText("findings")).toBeTruthy();
    expect(within(state).getByText("claim")).toBeTruthy();
  });

  test("a string state renders as one text block", () => {
    render(<JudgeToolResult params={{ state: "just some prose", questions: {} }} result={undefined} />);
    expect(screen.getByTestId("judge-tool-text").textContent).toBe("just some prose");
    expect(screen.getByText("no questions")).toBeTruthy();
  });
});
