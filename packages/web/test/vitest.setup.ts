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

// Unconditional (not `??=`): jsdom may ship a matchMedia stub that returns
// matches:false, which would push NumberFlow onto its animated path. Overwrite
// it so prefers-reduced-motion is actually pinned.
const matchMedia = (query: string) =>
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
(globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
if (typeof window !== "undefined") window.matchMedia = matchMedia;

// Vitest isolates test files but not individual tests within a file. A suite
// whose installFetchMock caller skips restore() (e.g. a bail before its
// try/finally) would leak the mock to the next test — restore the pristine
// fetch after every test as a guard.
const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
});
