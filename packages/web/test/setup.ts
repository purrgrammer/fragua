// happy-dom registration helpers.
//
// We do NOT register at import time: `GlobalRegistrator.register()` replaces
// globals like `WritableStream` / `ReadableStream` with happy-dom's
// implementations, which breaks Hono's SSE helper in other packages when
// the root `bun test ./packages` invocation runs every test suite in one
// process. Instead, tests that need a DOM call `useDom()` from a `describe`
// block; the returned teardown restores the prior globals.

import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Register happy-dom for the enclosing test suite and unregister after.
 * Idempotent across nested describes: only the outermost call does real work.
 */
export function useDom(): void {
  let installed = false;
  // Many DOM suites mock `globalThis.fetch` (a shared global) and only
  // `cleanup()` in afterEach — so a suite's mock LEAKS to whatever suite runs
  // next in the same `bun test` process. Under the wrong file order the next
  // suite's component fetches the previous suite's mock and fails — an
  // order-dependent flake (skills / selectors / file-viewer all failing
  // together is the signature). Snapshot fetch at suite start and restore it
  // at suite end so no suite can poison the next, without editing every file.
  let savedFetch: typeof globalThis.fetch | undefined;
  beforeAll(() => {
    savedFetch = globalThis.fetch;
    const g = globalThis as unknown as { __swarmWebDomInstalled?: boolean };
    if (!g.__swarmWebDomInstalled) {
      GlobalRegistrator.register();
      g.__swarmWebDomInstalled = true;
      installed = true;
    }
    // Override `matchMedia` to force `(prefers-reduced-motion: reduce)` in
    // tests. happy-dom provides a stub that returns `matches: false`, which
    // pushes `AnimatedNumber` down the NumberFlow custom-element path —
    // NumberFlow then injects a `<style>` tag whose content shows up in
    // `textContent` assertions, breaking exact-match tests. Forcing
    // reduced-motion here also neutralises the spin animation's timers.
    if (typeof window !== "undefined") {
      window.matchMedia = (query: string) =>
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
    }
  });
  afterAll(async () => {
    if (savedFetch !== undefined) globalThis.fetch = savedFetch;
    const g = globalThis as unknown as { __swarmWebDomInstalled?: boolean };
    if (installed && g.__swarmWebDomInstalled) {
      await GlobalRegistrator.unregister();
      g.__swarmWebDomInstalled = false;
    }
  });
}
