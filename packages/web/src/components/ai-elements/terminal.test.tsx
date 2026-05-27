// Pins the Terminal component's body surface to a theme-adapting token
// so Light mode doesn't render an immutable dark block. The original
// implementation hard-coded `bg-zinc-950 text-zinc-100` on
// `TerminalContent`, which ignores the `.dark` class on <html>.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { Terminal } from "./terminal.tsx";

describe("Terminal", () => {
  afterEach(() => cleanup());

  test("body surface adapts to light/dark mode (no hard-coded dark utility)", () => {
    const { getByTestId } = render(<Terminal output="hello" title="t" />);
    const root = getByTestId("terminal");
    // The scrollable body is the only child div whose classes target
    // the ANSI canvas (font-mono + overflow-auto).
    const body = root.querySelector("div.font-mono.overflow-auto") as HTMLElement | null;
    expect(body).not.toBeNull();
    const cls = body?.className ?? "";

    // Forbid an unconditional dark-only fill — it makes the component
    // identical in both themes, which is the bug. Either use a fragua
    // token (bg-sw-surface / bg-sw-bg) or gate the dark fill behind
    // the `dark:` variant.
    const hasUnconditionalZinc950 = /(?:^|\s)bg-zinc-950(?:\s|$)/.test(cls);
    const hasUnconditionalZinc100Text = /(?:^|\s)text-zinc-100(?:\s|$)/.test(cls);
    expect(hasUnconditionalZinc950).toBe(false);
    expect(hasUnconditionalZinc100Text).toBe(false);
  });
});
