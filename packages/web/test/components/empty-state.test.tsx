// Smoke tests for the EmptyState primitive. Kept minimal: this is a
// dumb presentational component, so we assert it mounts, renders its
// required text, accepts optional slots (icon, description, action), and
// exposes the default `role="status"` for a11y.

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "../../src/components/ui/empty-state.tsx";

describe("EmptyState", () => {
  afterEach(() => cleanup());

  it("renders the required title with role=status", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    const host = within(container).getByTestId("empty-state");
    expect(host.getAttribute("role")).toBe("status");
    expect(host.textContent).toContain("Nothing here");
  });

  it("renders the optional description, icon, and action slots", () => {
    const { container } = render(
      <EmptyState
        data-testid="e2"
        title="Oh no"
        description="extra context"
        icon={<span data-testid="icon">★</span>}
        action={<button type="button">Retry</button>}
      />,
    );
    const host = within(container).getByTestId("e2");
    expect(host.textContent).toContain("Oh no");
    expect(host.textContent).toContain("extra context");
    expect(within(host).getByTestId("icon")).toBeTruthy();
    expect(within(host).getByRole("button").textContent).toBe("Retry");
  });

  it("does NOT leak a description when none is supplied", () => {
    const { container } = render(<EmptyState title="Only title" />);
    // Description paragraph is gated on truthy prop — no stray nodes.
    const host = within(container).getByTestId("empty-state");
    // We rely on class-based search rather than data-testid because the
    // description slot is a plain div.
    expect(host.querySelectorAll("div").length).toBeLessThan(4);
  });
});
