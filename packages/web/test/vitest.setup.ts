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

// jsdom installs its own AbortController / AbortSignal as globals, but Node's
// undici (the Request constructor) brand-checks `signal` against ITS own
// AbortSignal class — not via `instanceof`, but a hidden webidl-brand check
// that only Node's AbortSignal carries. A jsdom AbortSignal flunks the check,
// so any code path that constructs a `new Request(url, { signal: ... })` with
// a jsdom-created signal crashes with `RequestInit: Expected signal to be an
// instance of AbortSignal`. React Router 7's data-router navigation does
// exactly this on every `<Navigate>` / `navigate()` call.
//
// We can't restore Node's AbortController (jsdom has overwritten the global
// before this setup file runs). Instead, wrap the Request constructor so it
// drops the offending `signal` when it isn't Node-branded. Tests don't need
// real cancellation; what we need is for navigation to not throw.
const NativeRequest = globalThis.Request;
class PatchedRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal !== undefined) {
      try {
        // Probe: build a throwaway Request with just the signal. If undici
        // rejects it, drop the signal from the real construction.
        new NativeRequest("http://x", { signal: init.signal });
      } catch {
        const { signal: _signal, ...rest } = init;
        super(input, rest);
        return;
      }
    }
    super(input, init);
  }
}
globalThis.Request = PatchedRequest as typeof Request;

// Vitest isolates each test file in its own environment, and suites that mock
// globalThis.fetch restore it themselves (installFetchMock's try/finally, or a
// per-test beforeEach reinstall). No global fetch restore here — a blanket
// afterEach restore would clobber a beforeEach-installed mock between tests.
afterEach(cleanup);
