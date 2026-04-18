#!/usr/bin/env bun
// Minimal test stub used as `swarmScript` by local-process-supervisor
// tests. Exits with the code from FAKE_EXIT_CODE (default 0) after
// optionally sleeping FAKE_SLEEP_MS so callers can test terminate().

const code = Number.parseInt(process.env["FAKE_EXIT_CODE"] ?? "0", 10);
const sleep = Number.parseInt(process.env["FAKE_SLEEP_MS"] ?? "0", 10);

if (sleep > 0) {
  setTimeout(() => process.exit(code), sleep);
  // Absorb SIGTERM so the test can verify terminate() works (exit 143
  // on SIGTERM by default; we force 143 explicitly to match the
  // typical shell convention).
  process.on("SIGTERM", () => process.exit(143));
} else {
  process.exit(code);
}
