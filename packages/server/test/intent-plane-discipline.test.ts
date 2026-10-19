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
// new route/adapter body — the one legitimate direct caller (the harness
// liveness adapter) is named in EXEMPT_FILES.
//
// This is an AST walk (not a regex over source text), so a computed member
// access — `store["enqueueRun"]()` — is caught the same as `store.enqueueRun()`.
// A write method reached through `.call` / `.apply` / `.bind` counts as a call,
// and a write method pulled into a local binding — by object destructuring
// (`const { enqueueRun } = store`, renamed or not) or by aliasing
// (`const w = store.enqueueRun`, `= store.enqueueRun.bind(store)`) — is flagged
// wherever that binding is called. Callees also go through the shared
// `normalizeCallee`, so `.call` on a destructured binding, a comma-wrapped
// callee (`(0, store.enqueueRun)(p)`) and an alias of an alias are caught too;
// only a member reach counts (a bare same-named import is not a store write).
// Shape mirrors packages/server/test/inline-import-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineOf, literalKey, normalizeCallee, parseSource, walk } from "@fragua/test-utils";
import ts from "typescript";

// Store-write methods that must only be reached through the intent plane
// (`commit*`). Beyond the original three, this now covers `setRunTitle` and the
// schedule CRUD mutators — both were adapter-side eventless / non-transactional
// writes before they were folded into the plane's atomic commits.
const WRITE_METHODS = new Set<string>([
  "appendIntent",
  // The checkout-release intent+fact commit: only `plane.commitCheckoutRelease`.
  "appendIntentWithFact",
  "enqueueRun",
  "saveWorkflow",
  "setRunTitle",
  "createSchedule",
  "pauseSchedule",
  "resumeSchedule",
  "deleteSchedule",
  "createScheduleAudited",
  "pauseScheduleAudited",
  "resumeScheduleAudited",
  "deleteScheduleAudited",
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
  // Legitimate direct `evictDaemonLockIfStale` caller, not an event-log bypass:
  //   - harness: its liveness adapter reaps a provably-dead daemon's lock on
  //     supervised restart and on its periodic reaper tick.
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

const FORWARDERS = new Set<string>(["call", "apply", "bind"]);

function skipParens(n: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(n) ? skipParens(n.expression) : n;
}

/** The write method an expression names, whether reached through a property
 * access (`store.enqueueRun`) or a literal-key element access
 * (`store["enqueueRun"]`). */
function writeAccessName(expr: ts.Expression): string | undefined {
  const e = skipParens(expr);
  const name = ts.isPropertyAccessExpression(e)
    ? e.name.text
    : ts.isElementAccessExpression(e)
      ? literalKey(e)
      : undefined;
  return name !== undefined && WRITE_METHODS.has(name) ? name : undefined;
}

/** The write method behind `<writeAccess>.call` / `.apply` / `.bind`. */
function forwardedWriteName(expr: ts.Expression): string | undefined {
  const e = skipParens(expr);
  if (!ts.isPropertyAccessExpression(e) || !FORWARDERS.has(e.name.text)) return undefined;
  return writeAccessName(e.expression);
}

/** Local name → write method, for every binding that holds a write method:
 * object-destructuring elements (`{ enqueueRun }`, `{ enqueueRun: e }`) and
 * `const w = store.enqueueRun` / `= store.enqueueRun.bind(store)` aliases. */
function writeBindings(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  walk(sf, (n) => {
    if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name)) {
      const prop = n.propertyName ?? n.name;
      const key = ts.isIdentifier(prop) || ts.isStringLiteralLike(prop) ? prop.text : undefined;
      if (key !== undefined && WRITE_METHODS.has(key)) out.set(n.name.text, key);
      return;
    }
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.initializer === undefined) return;
    const init = skipParens(n.initializer);
    const method = writeAccessName(init) ?? (ts.isCallExpression(init) ? bindTarget(init) : undefined);
    if (method !== undefined) out.set(n.name.text, method);
  });
  return out;
}

function bindTarget(call: ts.CallExpression): string | undefined {
  const callee = skipParens(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "bind") return undefined;
  return writeAccessName(callee.expression);
}

/** The write method a call reaches: directly, through `.call` / `.apply` /
 * `.bind`, through a local binding that holds one, or through any shape
 * `normalizeCallee` resolves to a member reach ending in a write method. */
function writeMethodOfCall(node: ts.CallExpression, bindings: Map<string, string>): string | undefined {
  const callee = skipParens(node.expression);
  const direct = writeAccessName(callee) ?? forwardedWriteName(callee);
  if (direct !== undefined) return direct;
  const bound = ts.isIdentifier(callee) ? bindings.get(callee.text) : undefined;
  if (bound !== undefined) return bound;
  const chain = normalizeCallee(callee)?.chain;
  const tail = chain?.at(-1);
  return chain !== undefined && chain.length >= 2 && tail !== undefined && WRITE_METHODS.has(tail) ? tail : undefined;
}

function scan(sf: ts.SourceFile): { method: string; line: number }[] {
  const bindings = writeBindings(sf);
  const out: { method: string; line: number }[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const method = writeMethodOfCall(n, bindings);
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

  test("flags a write method destructured off the store and called (R2-M4)", () => {
    const fixture = join(import.meta.dir, "fixtures", "intent-plane", "destructured.ts");
    expect(scan(parseSource(fixture)).map((h) => h.method)).toContain("enqueueRun");
  });

  test("flags store.enqueueRun.call(…) (R2-M4)", () => {
    const fixture = join(import.meta.dir, "fixtures", "intent-plane", "call-apply.ts");
    expect(scan(parseSource(fixture)).map((h) => h.method)).toContain("enqueueRun");
  });

  test("flags .apply / .bind on a write method, and renamed or aliased bindings", () => {
    expect(scanString(`store.enqueueRun.apply(store, [p]);\n`).map((h) => h.method)).toEqual(["enqueueRun"]);
    expect(scanString(`const f = store.enqueueRun.bind(store);\n`).map((h) => h.method)).toEqual(["enqueueRun"]);
    expect(scanString(`const { enqueueRun: e } = s;\ne(p);\n`).map((h) => h.method)).toEqual(["enqueueRun"]);
    expect(scanString(`const w = s.enqueueRun;\nw(p);\n`).map((h) => h.method)).toEqual(["enqueueRun"]);
    expect(scanString(`const w = s["saveWorkflow"];\nw(x);\n`).map((h) => h.method)).toEqual(["saveWorkflow"]);
  });

  test("flags .call on a destructured binding, a comma-wrapped callee, and an alias of an alias (R2-M4 re-probe)", () => {
    expect(scanString(`const { enqueueRun } = store;\nenqueueRun.call(store, p);\n`).map((h) => h.method)).toEqual([
      "enqueueRun",
    ]);
    expect(scanString(`(0, store.enqueueRun)(p);\n`).map((h) => h.method)).toEqual(["enqueueRun"]);
    expect(scanString(`const a = store.enqueueRun;\nconst b = a;\nb(p);\n`).map((h) => h.method)).toEqual([
      "enqueueRun",
    ]);
  });

  test("does not flag a commit* reached through an alias (control)", () => {
    expect(scanString(`const c = plane.commitEnqueue;\nc(x);\n`)).toEqual([]);
  });

  test("flags the *Audited schedule writers", () => {
    expect(scanString(`store.pauseScheduleAudited(id, ev, now);\n`).map((h) => h.method)).toEqual([
      "pauseScheduleAudited",
    ]);
  });

  test("does not flag destructured non-write methods", () => {
    expect(scanString(`const { getState } = store;\ngetState(id);\n`)).toEqual([]);
  });

  test("exempts harness.ts as the documented direct coordinator caller", () => {
    expect(EXEMPT_FILES.has("packages/cli/src/commands/harness.ts")).toBe(true);
    expect(EXEMPT_FILES.has("packages/server/src/reaper.ts")).toBe(false);
  });
});
