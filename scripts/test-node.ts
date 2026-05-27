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

const res = spawnSync("bun", ["test", ...args], { stdio: "inherit" });
// status is null when the child was killed by a signal (e.g. Ctrl-C) — re-raise
// it so a SIGINT isn't reported as a generic test failure.
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
