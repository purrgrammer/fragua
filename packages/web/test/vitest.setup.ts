// Global test setup — runs once per test file before the suite.
//
// jsdom omits a handful of layout/interaction APIs that Radix UI primitives
// touch on mount; without these shims the dialog/menu content throws or never
// renders. We also pin prefers-reduced-motion so NumberFlow stays on its
// static path (its animated path injects a <style> tag that pollutes
// textContent assertions) and animation timers don't fire.

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const elementProto = globalThis.Element?.prototype as unknown as {
  hasPointerCapture?: () => boolean;
  setPointerCapture?: () => void;
  releasePointerCapture?: () => void;
  scrollIntoView?: () => void;
};
elementProto.hasPointerCapture ??= () => false;
elementProto.setPointerCapture ??= () => {};
elementProto.releasePointerCapture ??= () => {};
elementProto.scrollIntoView ??= () => {};

if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// jsdom doesn't implement object URLs; the file viewer creates one for image blobs.
const urlCtor = globalThis.URL as unknown as {
  createObjectURL?: (blob: unknown) => string;
  revokeObjectURL?: (url: string) => void;
};
urlCtor.createObjectURL ??= () => "blob:mock";
urlCtor.revokeObjectURL ??= () => {};

(globalThis as { matchMedia?: unknown }).matchMedia ??= (query: string) =>
  ({
    matches: query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

afterEach(() => cleanup());
