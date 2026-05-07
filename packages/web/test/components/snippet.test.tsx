// `Snippet` / `SnippetCopyButton` size-parity contract.
//
// The Snippet wraps an InputGroup, which establishes a fixed `h-8`
// (32px) row. The auto-rendered copy button must fill that row —
// otherwise it visually floats inside the pill and the snippet looks
// taller than the button. This test pins the size class so a regression
// (e.g. switching back to `icon-xs` → `size-6`) trips immediately.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { Snippet } from "../../src/components/ai-elements/snippet.tsx";
import { useDom } from "../setup.ts";

describe("SnippetCopyButton", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders at the same height as the enclosing Snippet row (size-8, matching InputGroup's h-8)", () => {
    const { container } = render(<Snippet code="gh pr list" prefix="$" />);

    const group = container.querySelector('[data-slot="snippet"]');
    expect(group).not.toBeNull();
    expect(group?.className).toContain("h-auto");

    // The auto-rendered copy button is the only <button> the Snippet
    // emits in its default shape.
    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    // Size parity: the button must be 32px square (size-8) so it
    // matches the InputGroup's h-8 row. `icon-xs` (size-6 / 24px) is
    // the regression we're guarding against.
    const cls = button?.className ?? "";
    expect(cls).toContain("size-8");
    expect(cls).not.toContain("size-6");
  });
});
