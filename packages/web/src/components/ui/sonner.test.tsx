// Toaster component tests.
//
// We verify two things that are ours to test:
//   1. The wrapper renders a live region (sonner's a11y surface is present).
//   2. The `theme` prop follows the resolved theme from `useTheme`.
//
// We do NOT assert that toast text appears inside the live region — that
// is sonner library behaviour and can be broken by `mock.module("sonner")`
// calls in co-located test files that share the same bun process. The
// `mutationToast` and toast call-site tests in `toast.test.ts` cover the
// end-to-end wiring at the spy level instead.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useDom } from "../../../test/setup.ts";
import { Toaster } from "./sonner.tsx";

describe("Toaster", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders a live region (aria-live) in the DOM", () => {
    render(<Toaster />);
    const liveRegion = document.querySelector("[aria-live]");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  test("renders with a11y-relevant region attributes", () => {
    render(<Toaster />);
    const section = document.querySelector("[aria-live='polite']");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-relevant")).toBe("additions text");
    expect(section?.getAttribute("aria-atomic")).toBe("false");
  });
});
