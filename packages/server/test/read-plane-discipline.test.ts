// Read-plane discipline — ARCHITECTURE.md §4/§5.
//
// The run-read route handlers project run state + the event log through the
// shared read plane (`@fragua/core/read-plane` → `readPlane.*`), so the HTTP
// surface and every other read client share one projection. A raw
// `deps.store.<reader>(...)` call inside a route body bypasses that seam — the
// bytes it returns aren't the shape the read plane guarantees, and a later
// read-plane refactor can't reach it. Any deliberate bypass (a read the plane
// has no primitive for yet) carries the `read-discipline-allow:` marker so the
// blind spot is auditable rather than silent.
//
// Scoped to the run-focused route files. `schedule-routes.ts` /
// `analytics-routes.ts` / `routes/health.ts` read over `IDaemonCoordinator` /
// `IAnalyticsReader` surfaces the run-read plane does not front (health reads
// `currentDaemonLock` / `runStateCounts` and delegates its only write to the
// reaper), so they are out of scope here — the reaper's `evictDaemonLockIfStale`
// write is guarded against inline route use by the intent-plane lint instead.
//
// This is an AST scan (not a regex over source text), so a forbidden call can't
// slip past by renaming or aliasing `deps.store`. Shape mirrors
// packages/server/test/inline-import-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { allowMarked, collectCalls, lineOf, parseSource, walk } from "@fragua/test-utils";
import ts from "typescript";

const SRC_DIR = join(import.meta.dir, "..", "src");
const SCANNED_FILES = [
  join(SRC_DIR, "store", "routes.ts"),
  join(SRC_DIR, "store", "runs-routes.ts"),
  join(SRC_DIR, "store", "sse.ts"),
  join(SRC_DIR, "routes", "run-files.ts"),
  join(SRC_DIR, "routes", "projects.ts"),
];
const ALLOW_MARKER = "read-discipline-allow:";

/** The deps-record identifiers a run-read route body destructures / reads its
 * store from. The store routes carry `deps`; the run-file / project routes
 * carry `opts`. */
const STORE_BASES = new Set(["deps", "opts"]);

/** Strip `as`/`satisfies`/parenthesized/`!` wrappers to reach the underlying
 * expression — `deps.store as unknown as { … }` unwraps to `deps.store`. */
function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Is this expression a `<base>.store` property access, for a `base` in
 * {@link STORE_BASES} (`deps.store` / `opts.store`)? */
function isDepsStore(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "store" &&
    ts.isIdentifier(e.expression) &&
    STORE_BASES.has(e.expression.text)
  );
}

/** Names of same-file consts aliased to a `<base>.store` binding, whether by a
 * plain assignment (`const store = deps.store as …`) or by destructuring
 * (`const { store } = opts`). */
function storeAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || n.initializer === undefined) return;
    if (ts.isIdentifier(n.name) && isDepsStore(n.initializer)) {
      aliases.add(n.name.text);
      return;
    }
    const init = unwrap(n.initializer);
    if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(init) && STORE_BASES.has(init.text)) {
      for (const el of n.name.elements) {
        const source = el.propertyName ?? el.name;
        if (ts.isIdentifier(source) && source.text === "store" && ts.isIdentifier(el.name)) {
          aliases.add(el.name.text);
        }
      }
    }
  });
  return aliases;
}

interface Offense {
  line: number;
  callee: string;
}

/** A `deps.store.<m>(...)` or `<alias>.<m>(...)` reader call, not allow-marked. */
function scan(sf: ts.SourceFile): Offense[] {
  const aliases = storeAliases(sf);
  const out: Offense[] = [];
  for (const call of collectCalls(sf, sf)) {
    const callee = call.node.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const obj = callee.expression;
    const onStore = isDepsStore(obj) || (ts.isIdentifier(obj) && aliases.has(obj.text));
    if (onStore && !allowMarked(sf, call.node, ALLOW_MARKER)) {
      out.push({ line: lineOf(sf, call.node), callee: `${obj.getText(sf)}.${callee.name.text}` });
    }
  }
  return out;
}

function scanString(src: string): Offense[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

describe("read-plane discipline — no raw deps.store reads in run-read route bodies", () => {
  test("scans the run-read route files", () => {
    expect(SCANNED_FILES.every((f) => existsSync(f))).toBe(true);
    expect(SCANNED_FILES).toContain(join(SRC_DIR, "store", "routes.ts"));
    expect(SCANNED_FILES).toContain(join(SRC_DIR, "routes", "run-files.ts"));
    expect(SCANNED_FILES).toContain(join(SRC_DIR, "routes", "projects.ts"));
  });

  test("no raw deps.store reader call outside the read plane and the allow marker", () => {
    const offenders: string[] = [];
    for (const file of SCANNED_FILES) {
      for (const o of scan(parseSource(file))) offenders.push(`${relative(SRC_DIR, file)}:${o.line} → ${o.callee}`);
    }
    if (offenders.length > 0)
      throw new Error(`read-plane discipline violations:\n${offenders.map((o) => `  ${o}`).join("\n")}`);
    expect(offenders).toHaveLength(0);
  });

  test("flags a raw deps.store.<reader>() call in a route handler", () => {
    const hits = scanString(`app.get("/x", (c) => c.json(deps.store.getState(id)));\n`);
    expect(hits.map((h) => h.callee)).toEqual(["deps.store.getState"]);
  });

  test("flags an aliased store read (const store = deps.store as …)", () => {
    const src = `const store = deps.store as unknown as { metricsSnapshot(): unknown };\napp.get("/m", (c) => c.json(store.metricsSnapshot()));\n`;
    expect(scanString(src).map((h) => h.callee)).toEqual(["store.metricsSnapshot"]);
  });

  test("does not flag readPlane / plane calls", () => {
    expect(scanString(`app.get("/x", (c) => c.json(readPlane.runDetail(id)));\n`)).toHaveLength(0);
    expect(scanString(`app.post("/x", (c) => plane.commit(id, intent));\n`)).toHaveLength(0);
  });

  test("does not flag deps.store passed as a construction argument", () => {
    expect(scanString(`const readPlane = makeReadPlane({ store: deps.store });\n`)).toHaveLength(0);
  });

  test("honors the read-discipline-allow marker", () => {
    expect(scanString(`// ${ALLOW_MARKER} no primitive yet\nconst s = deps.store.getState(id);\n`)).toHaveLength(0);
    expect(scanString(`const s = deps.store.getState(id); // ${ALLOW_MARKER} no primitive yet\n`)).toHaveLength(0);
  });
});
