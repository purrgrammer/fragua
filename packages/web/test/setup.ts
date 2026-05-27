// `useDom()` is a no-op under Vitest: the jsdom environment is configured
// globally in vitest.config.ts and DOM shims live in test/vitest.setup.ts.
// It is kept callable so the suites that open with `useDom()` need no edit;
// Vitest also isolates each test file, so the fetch-leak guard the old
// happy-dom version carried is no longer needed.
export function useDom(): void {
  // intentional shim — see header; ~30 suites still call this. Do not remove.
}
