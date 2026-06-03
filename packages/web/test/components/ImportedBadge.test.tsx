// ImportedBadge — renders a status-pill-shaped badge with text "imported".

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ImportedBadge } from "../../src/components/ImportedBadge.tsx";

describe("ImportedBadge", () => {
  afterEach(() => cleanup());

  test("renders text 'imported' with status-pill shape (data-testid='imported-badge')", () => {
    const { getByTestId } = render(<ImportedBadge />);
    const badge = getByTestId("imported-badge");
    expect(badge.textContent).toBe("imported");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("border");
  });

  test("accepts a custom data-testid", () => {
    const { getByTestId } = render(<ImportedBadge data-testid="detail-imported-badge" />);
    expect(getByTestId("detail-imported-badge").textContent).toBe("imported");
  });

  test("does not contain '(inert)' or 'inspect-only' copy", () => {
    const { getByTestId } = render(<ImportedBadge />);
    expect(getByTestId("imported-badge").textContent).not.toMatch(/inert|inspect-only/i);
  });
});
