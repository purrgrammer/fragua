// Intent-plane discipline (intent-plane.md §3.1): the plane
// (@fragua/core/intent-plane) is the ONLY place allowed to call the three
// store-write methods it owns — `appendIntent`, `enqueueRun`, `saveWorkflow`.
// Adapters (HTTP routes, the daemon dispatcher) must go through
// `plane.commit` / `commitEnqueue` / `commitSaveWorkflow`. This scan fails the
// build if a store-write call appears in an adapter, so "one audit surface for
// writes" is enforced, not merely asserted in prose.
//
// Shape: packages/core/test/handler/discipline.test.ts, store/test/lint.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WRITE_METHODS = ["appendIntent", "enqueueRun", "saveWorkflow"] as const;
const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/server/test
const SCAN_DIRS = [join(ROOT, "packages/server/src"), join(ROOT, "packages/daemon/src")];

// TRACKED ALLOWANCE — remove with the accept/discard de-smell (§3.7, "increment
// 3"). `accept`/`discard` do synchronous local git then record
// `intent.accept_run` / `intent.discard_run` directly. Folding the gate into
// `@fragua/workspace` + routing the write through the plane drops these two; the
// count assertion then fails and forces this allowance to be deleted (the scan
// should find ZERO).
const ALLOWED_FILE = "packages/server/src/store/routes.ts";
const ALLOWED_METHOD = "appendIntent";
const ALLOWED_COUNT = 2;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const hits: { rel: string; method: string; line: number }[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walkTs(dir)) {
    const rel = file.slice(ROOT.length + 1);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const m of WRITE_METHODS) {
          if (new RegExp(`\\.${m}\\(`).test(text)) hits.push({ rel, method: m, line: i + 1 });
        }
      });
  }
}

describe("intent-plane discipline — store writes only inside the plane", () => {
  test("no store-write call in an adapter (except the tracked accept/discard allowance)", () => {
    const forbidden = hits.filter((h) => !(h.rel === ALLOWED_FILE && h.method === ALLOWED_METHOD));
    // If this fails: route the write through plane.commit / commitEnqueue /
    // commitSaveWorkflow instead of calling the store method directly.
    expect(forbidden).toEqual([]);
  });

  test("the accept/discard allowance is exactly the 2 known calls (ratchet for §3.7)", () => {
    const allowed = hits.filter((h) => h.rel === ALLOWED_FILE && h.method === ALLOWED_METHOD);
    expect(allowed.length).toBe(ALLOWED_COUNT);
  });
});
