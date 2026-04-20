// `AnimatedNumber` contract tests. The component is a thin `NumberFlow`
// wrapper with a non-finite fallback and a `prefers-reduced-motion`
// short-circuit; both branches are exercised here.
//
// Note on the DOM stub: `test/setup.ts` stubs `window.matchMedia` to
// report `matches: true` for `(prefers-reduced-motion: reduce)`. That
// puts `AnimatedNumber` on the plain-`<span>` path in every test here,
// which makes `textContent` assertions stable (NumberFlow's custom
// element renders its digits into shadow DOM, which happy-dom only
// partially materialises).

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { AnimatedNumber } from "../../src/components/ui/animated-number.tsx";
import { tokensCompactFormatOptions, usdFormatOptions } from "../../src/lib/format.ts";
import { useDom } from "../setup.ts";

describe("AnimatedNumber", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the formatted currency value with usdFormatOptions", () => {
    const { container } = render(
      <AnimatedNumber value={0.1234} format={usdFormatOptions(0.1234)} locale="en-US" />,
    );
    // < $1 uses 3 fraction digits by contract.
    expect(container.textContent).toContain("$0.123");
  });

  it("renders compact tokens for large values", () => {
    const { container } = render(
      <AnimatedNumber value={4200} format={tokensCompactFormatOptions(4200)} locale="en-US" />,
    );
    expect(container.textContent).toContain("4.2K");
  });

  it("renders `0` (not the fallback) for a zero-value numeric input", () => {
    // Regression guard: queue/outcome tiles lean on this — `0` is a finite
    // number and must animate through to NumberFlow, not decay to "—".
    const { container } = render(<AnimatedNumber value={0} locale="en-US" />);
    expect(container.textContent).toBe("0");
  });

  it("falls back to `—` for undefined", () => {
    const { container } = render(<AnimatedNumber value={undefined} />);
    expect(container.textContent).toBe("—");
  });

  it("falls back to `—` for NaN", () => {
    const { container } = render(<AnimatedNumber value={Number.NaN} />);
    expect(container.textContent).toBe("—");
  });

  it("falls back to `—` for Infinity", () => {
    const { container } = render(<AnimatedNumber value={Number.POSITIVE_INFINITY} />);
    expect(container.textContent).toBe("—");
  });

  it("respects a custom `fallback`", () => {
    const { container } = render(<AnimatedNumber value={undefined} fallback="N/A" />);
    expect(container.textContent).toBe("N/A");
  });

  it("takes the plain-span path when prefers-reduced-motion matches (no <number-flow> element)", () => {
    const { container } = render(<AnimatedNumber value={42} locale="en-US" />);
    // The stub in test/setup.ts forces the reduced-motion path, so no
    // custom element should appear in the rendered tree.
    expect(container.querySelector("number-flow")).toBeNull();
    expect(container.textContent).toBe("42");
  });

  it("includes prefix and suffix in the rendered text", () => {
    const { container } = render(
      <AnimatedNumber value={5} prefix="~" suffix=" runs" locale="en-US" />,
    );
    expect(container.textContent).toBe("~5 runs");
  });
});
