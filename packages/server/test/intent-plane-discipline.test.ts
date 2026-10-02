// Intent-plane discipline (intent-plane.md §3.1): the plane
// (@fragua/core/intent-plane) is the ONLY place allowed to call the three
// store-write methods it owns — `appendIntent`, `enqueueRun`, `saveWorkflow`.
// Adapters (HTTP routes, the daemon dispatcher, the CLI store-client) must
// go through `plane.commit` / `commitEnqueue` / `commitSaveWorkflow`. This
// scan fails the build if a store-write call appears in an adapter, so "one
// audit surface for writes" is enforced, not merely asserted in prose.
// The plane's own internals (packages/core/src/intent-plane) are exempt by
// construction: core is not in SCAN_DIRS.
//
// Shape: packages/core/test/handler/discipline.test.ts, store/test/lint.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Store-write methods that must only be reached through the intent plane
// (`commit*`). Beyond the original three, this now covers `setRunTitle` and the
// schedule CRUD mutators — both were adapter-side eventless / non-transactional
// writes before they were folded into the plane's atomic commits.
const WRITE_METHODS = [
  "appendIntent",
  "enqueueRun",
  "saveWorkflow",
  "setRunTitle",
  "createSchedule",
  "pauseSchedule",
  "resumeSchedule",
  "deleteSchedule",
] as const;
const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/server/test

/** Sanctioned direct callers of otherwise-plane-only writes:
 *   - auto-titler: projects an asynchronously-generated title onto
 *     `run_state.title` long after enqueue, so it cannot ride the genesis event
 *     the operator title does — an explicit out-of-band projection write.
 *   - schedule-dispatcher: auto-PAUSES a schedule on an unresolvable/invalid
 *     workflow, each paired with its own `fact.schedule_invalid_workflow` audit
 *     event — a daemon-internal reaction, not an operator `intent.schedule_pause`.
 *  Both are legitimate transitions with their own audit trail, not event-log
 *  bypasses, so they are exempt from the plane-only rule. */
const EXEMPT_FILES = new Set<string>([
  "packages/daemon/src/auto-titler.ts",
  "packages/daemon/src/schedule-dispatcher.ts",
]);
const SCAN_DIRS = [
  join(ROOT, "packages/server/src"),
  join(ROOT, "packages/daemon/src"),
  join(ROOT, "packages/cli/src"),
  join(ROOT, "packages/workspace/src"),
  join(ROOT, "packages/agent/src"),
];

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
    const rel = file
      .slice(ROOT.length + 1)
      .split("\\")
      .join("/");
    if (EXEMPT_FILES.has(rel)) continue;
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
  test("no store-write call in any adapter (server routes, daemon dispatcher, cli)", () => {
    // If this fails: route the write through plane.commit / commitEnqueue /
    // commitSaveWorkflow instead of calling the store method directly.
    expect(hits).toEqual([]);
  });
});
