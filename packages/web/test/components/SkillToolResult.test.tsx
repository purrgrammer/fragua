// SkillToolResult — viz card for the built-in `skill` tool.
//
// Asserts the structured payload (name, description, path, content) on
// `result.details.data` round-trips into the DOM, and that the
// arguments pill / collapsible body / error variant render conditionally
// against the proposal's contract.

import type { ToolResultMessage } from "@fragua/types";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SkillToolResult } from "../../src/components/run-conversation/SkillToolResult.tsx";
import { useDom } from "../setup.ts";

function makeResult(opts: {
  data?: { name?: string; description?: string; path?: string; content?: string; available?: string[] };
  text?: string;
  isError?: boolean;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "skill",
    content: opts.text ? [{ type: "text", text: opts.text }] : [],
    isError: opts.isError ?? false,
    details: opts.data ? { data: opts.data } : undefined,
    timestamp: 0,
  } as unknown as ToolResultMessage;
}

describe("SkillToolResult", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders skill name and description from result.details.data", () => {
    const result = makeResult({
      data: {
        name: "frontend",
        description: "React patterns",
        path: "/abs/skills/frontend/SKILL.md",
        content: "use react",
      },
      text: "# Skill: frontend\n_React patterns_\n\nuse react",
    });
    const { container } = render(<SkillToolResult params={{ name: "frontend" }} result={result} />);
    const q = within(container);
    expect(q.getByTestId("skill-card-name").textContent).toBe("frontend");
    expect(q.getByTestId("skill-card-description").textContent).toBe("React patterns");
    // Path surfaces in the header so operators can jump to the source file.
    expect(container.textContent ?? "").toContain("/abs/skills/frontend/SKILL.md");
  });

  it("renders a collapsible body summary keyed off content length", () => {
    const body = "use react\n".repeat(50);
    const result = makeResult({
      data: {
        name: "frontend",
        description: "d",
        path: "/p",
        content: body,
      },
    });
    const { container } = render(<SkillToolResult params={{ name: "frontend" }} result={result} />);
    const q = within(container);
    const details = q.getByTestId("skill-card-body");
    expect(details).toBeTruthy();
    // The summary advertises char count so the operator knows what to expect.
    expect(details.textContent ?? "").toContain(body.length.toLocaleString());
    // <details> defaults to closed in happy-dom.
    expect((details as HTMLDetailsElement).open).toBe(false);
  });

  it("renders truncated arguments pill when params.arguments is set", () => {
    const longArgs = "x".repeat(500);
    const result = makeResult({
      data: { name: "x", description: "d", path: "/p", content: "body" },
    });
    const { container } = render(<SkillToolResult params={{ name: "x", arguments: longArgs }} result={result} />);
    const q = within(container);
    const pill = q.getByTestId("skill-card-arguments");
    expect(pill.textContent).toBe(longArgs);
    // Single-line clamp \u2014 inline style sets nowrap so the layout doesn't
    // break on huge args.
    expect((pill as HTMLElement).style.whiteSpace).toBe("nowrap");
  });

  it("does not render the arguments pill when params.arguments is empty", () => {
    const result = makeResult({
      data: { name: "x", description: "d", path: "/p", content: "body" },
    });
    const { container } = render(<SkillToolResult params={{ name: "x" }} result={result} />);
    expect(within(container).queryByTestId("skill-card-arguments")).toBeNull();
  });

  it("renders the error panel when result.isError is true", () => {
    const result = makeResult({
      isError: true,
      text: 'unknown skill "z". available: a, b, c',
    });
    const { container } = render(<SkillToolResult params={{ name: "z" }} result={result} />);
    const q = within(container);
    const err = q.getByTestId("skill-card-error");
    expect(err.textContent).toContain("unknown skill");
    expect(err.textContent).toContain("a, b, c");
    // The body collapsible is suppressed on error \u2014 the error IS the body.
    expect(q.queryByTestId("skill-card-body")).toBeNull();
  });
});
