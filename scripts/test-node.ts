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

const dirs = readdirSync("packages", { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "web")
  .map((e) => `./packages/${e.name}`)
  .sort();

const passthrough = process.argv.slice(2);
const args = passthrough.length > 0 ? passthrough : dirs;

const res = spawnSync("bun", ["test", ...args], { stdio: "inherit" });
process.exit(res.status ?? 1);
