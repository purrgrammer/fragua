// Run `bun test` over every package EXCEPT @fragua/web.
//
// Web runs on vitest + jsdom (see packages/web/vitest.config.ts) because
// bun's runner + happy-dom can't mount Radix portals. Everything else runs on
// bun. Auto-discovering the package dirs (rather than a hand-maintained list)
// means a new node package is covered the moment it exists — no drift.
//
// Extra args pass through: `bun run scripts/test-node.ts ./packages/store -t foo`.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Packages that run on vitest (jsdom), not bun's runner. Add new vitest-only
// packages here so they don't silently join the bun pool.
const VITEST_ONLY = new Set(["web"]);

const dirs = readdirSync("packages", { withFileTypes: true })
  .filter((e) => e.isDirectory() && !VITEST_ONLY.has(e.name))
  .map((e) => `./packages/${e.name}`)
  .sort();

const passthrough = process.argv.slice(2);
const args = passthrough.length > 0 ? passthrough : dirs;

// Default per-test timeout. bun's built-in default is 5s, which the heaviest
// driven properties (executor-faults, agent resume) can brush even at the 1x
// baseline on a loaded machine. bunfig.toml has no `[test] timeout` key in bun
// 1.2.17 — verified: it is ignored and the 5s default applies — so the floor
// has to be set here, on the one command CLAUDE.md tells contributors to run.
//
// It must NOT be a per-test `test(name, fn, ms)` literal: that form OVERRIDES
// `bun test --timeout`, so the CI workflows' larger allowances were silently
// capped at whatever the literal said. That is what timed out the nightly.
// Keep the wall clock a command-line concern so the workflow that scales
// FRAGUA_PBT_RUNS can scale the time budget with it.
const hasTimeout = args.some((a) => a === "--timeout" || a.startsWith("--timeout="));
const timeout = hasTimeout ? [] : ["--timeout", "60000"];

const res = spawnSync("bun", ["test", ...timeout, ...args], { stdio: "inherit" });
// status is null when the child was killed by a signal (e.g. Ctrl-C) — re-raise
// it so a SIGINT isn't reported as a generic test failure.
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
