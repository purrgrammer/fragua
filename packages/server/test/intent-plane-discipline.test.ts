// Intent-plane discipline (intent-plane.md §3.1): the plane
// (@fragua/core/intent-plane) is the ONLY place allowed to call the
// store-write methods it owns — `appendIntent`, `enqueueRun`, `saveWorkflow`,
// `setRunTitle`, and the schedule CRUD mutators. Adapters (HTTP routes, the
// daemon dispatcher, the CLI store-client) must go through `plane.commit` /
// `commitEnqueue` / `commitSaveWorkflow`. This scan fails the build if a
// store-write call appears in an adapter, so "one audit surface for writes" is
// enforced, not merely asserted in prose. The plane's own internals
// (packages/core/src/intent-plane) are exempt by construction: core is not in
// SCAN_DIRS.
//
// Beyond the plane-owned writes, this also guards the `IDaemonCoordinator`
// lock-eviction write `evictDaemonLockIfStale`: it must never be inlined into a
// new route/adapter body — the two legitimate direct callers (the reaper
// delegate + the harness liveness adapter) are named in EXEMPT_FILES.
//
// This is an AST walk (not a regex over source text), so a computed member
// access — `store["enqueueRun"]()` — is caught the same as `store.enqueueRun()`.
// Shape mirrors packages/server/test/inline-import-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineOf, parseSource, walk } from "@fragua/test-utils";
import ts from "typescript";

// Store-write methods that must only be reached through the intent plane
// (`commit*`). Beyond the original three, this now covers `setRunTitle` and the
// schedule CRUD mutators — both were adapter-side eventless / non-transactional
// writes before they were folded into the plane's atomic commits.
const WRITE_METHODS = new Set<string>([
  "appendIntent",
  "enqueueRun",
  "saveWorkflow",
  "setRunTitle",
  "createSchedule",
  "pauseSchedule",
  "resumeSchedule",
  "deleteSchedule",
  "evictDaemonLockIfStale",
]);
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
  // Legitimate direct `evictDaemonLockIfStale` callers, not event-log bypasses:
  //   - reaper: the daemon-recovery delegate every process (the /health path
  //     included) routes stale-lock recovery through, so the TTL check + sweep +
  //     audit events land in one place.
  //   - harness: its liveness adapter reaps a provably-dead daemon's lock on
  //     supervised restart.
  "packages/server/src/reaper.ts",
  "packages/cli/src/commands/harness.ts",
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

/** The write-method name a call's callee names, whether reached through a
 * property access (`store.enqueueRun(...)`) or a computed element access with a
 * string-literal key (`store["enqueueRun"](...)`). */
function writeMethodOfCall(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) return callee.name.text;
  if (ts.isElementAccessExpression(callee)) {
    const arg = callee.argumentExpression;
    if (ts.isStringLiteralLike(arg) && WRITE_METHODS.has(arg.text)) return arg.text;
  }
  return undefined;
}

function scan(sf: ts.SourceFile): { method: string; line: number }[] {
  const out: { method: string; line: number }[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const method = writeMethodOfCall(n);
    if (method !== undefined) out.push({ method, line: lineOf(sf, n) });
  });
  return out;
}

function scanString(src: string): { method: string; line: number }[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

const hits: { rel: string; method: string; line: number }[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walkTs(dir)) {
    const rel = file
      .slice(ROOT.length + 1)
      .split("\\")
      .join("/");
    if (EXEMPT_FILES.has(rel)) continue;
    for (const h of scan(parseSource(file))) hits.push({ rel, method: h.method, line: h.line });
  }
}

describe("intent-plane discipline — store writes only inside the plane", () => {
  test("no store-write call in any adapter (server routes, daemon dispatcher, cli)", () => {
    // If this fails: route the write through plane.commit / commitEnqueue /
    // commitSaveWorkflow instead of calling the store method directly.
    expect(hits).toEqual([]);
  });

  test("flags computed store['enqueueRun']() access", () => {
    expect(scanString(`store["enqueueRun"](params);\n`).map((h) => h.method)).toContain("enqueueRun");
  });

  test("honours EXEMPT_FILES and dotted commit* passthrough", () => {
    expect(EXEMPT_FILES.has("packages/daemon/src/auto-titler.ts")).toBe(true);
    expect(scanString(`plane.commit(x); plane.commitEnqueue(y); plane.commitSaveWorkflow(z);\n`)).toEqual([]);
  });

  test("flags a route body calling the coordinator write evictDaemonLockIfStale", () => {
    const src = `app.get("/x", (c) => { deps.store.evictDaemonLockIfStale(o); return c.json({}); });\n`;
    expect(scanString(src).map((h) => h.method)).toContain("evictDaemonLockIfStale");
  });

  test("exempts reaper.ts and harness.ts as documented direct coordinator callers", () => {
    expect(EXEMPT_FILES.has("packages/server/src/reaper.ts")).toBe(true);
    expect(EXEMPT_FILES.has("packages/cli/src/commands/harness.ts")).toBe(true);
  });
});
