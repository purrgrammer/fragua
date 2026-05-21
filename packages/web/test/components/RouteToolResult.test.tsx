// RouteToolResult — viz card for the built-in `route` tool.
//
// The backend synthesises a per-routing-node `route` tool; the chosen branch
// lands on `params.name` (agent's input) and is echoed on
// `result.details.data.route`. These tests assert that the card surfaces the
// chosen route clearly and degrades gracefully in every state.

import { afterEach, describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@fragua/types";
import { cleanup, render, within } from "@testing-library/react";
import { RouteToolResult } from "../../src/components/run-conversation/RouteToolResult.tsx";
import { useDom } from "../setup.ts";

function makeResult(opts: { data?: { route?: string }; text?: string; isError?: boolean }): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-route",
    toolName: "route",
    content: opts.text ? [{ type: "text", text: opts.text }] : [],
    isError: opts.isError ?? false,
    details: opts.data ? { data: opts.data } : undefined,
    timestamp: 0,
  } as unknown as ToolResultMessage;
}

describe("RouteToolResult", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the chosen route from result.details.data.route", () => {
    const result = makeResult({ data: { route: "small" }, text: "route: small" });
    const { container } = render(<RouteToolResult params={{ name: "small" }} result={result} />);
    const q = within(container);
    // The canonical echo from the tool's execute() is displayed.
    expect(q.getByTestId("route-card-name").textContent).toBe("small");
  });

  it("falls back to params.name when result is absent (streaming state)", () => {
    // No result yet — tool call is still in-flight.
    const { container } = render(<RouteToolResult params={{ name: "feature" }} result={undefined} />);
    const q = within(container);
    expect(q.getByTestId("route-card-name").textContent).toBe("feature");
  });

  it("renders a placeholder when neither params nor result carry a route", () => {
    const { container } = render(<RouteToolResult params={undefined} result={undefined} />);
    const q = within(container);
    const card = q.getByTestId("route-card");
    expect(card).toBeTruthy();
    // Placeholder text must be non-empty and communicate absence.
    expect(q.getByTestId("route-card-name").textContent).toBe("(no route chosen)");
  });

  it("does not use the error accent color — routing is a neutral step", () => {
    const result = makeResult({ data: { route: "happy" }, text: "route: happy" });
    const { container } = render(<RouteToolResult params={{ name: "happy" }} result={result} />);
    const q = within(container);
    const card = q.getByTestId("route-card") as HTMLElement;
    // happy-dom strips color-mix() from the card's inline style, but it
    // preserves simple `color:` values on child elements. Assert via the
    // icon SVG's style attribute, which carries the decision/neutral accent
    // token literally. This proves the component uses --sw-accent-thinking,
    // not --sw-accent-error.
    const icon = card.querySelector("svg") as HTMLElement | null;
    expect(icon).not.toBeNull();
    const iconStyle = icon?.getAttribute("style") ?? "";
    expect(iconStyle).toContain("sw-accent-thinking");
    expect(iconStyle).not.toContain("sw-accent-error");
  });
});
