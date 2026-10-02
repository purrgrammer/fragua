// Handler discipline + browser safety — ARCHITECTURE.md §5.
//
// Handlers receive their I/O through HandlerContext (ctx.llm, ctx.http,
// ctx.tools, ctx.messages, ctx.artifacts, ctx.externalCall). A handler that
// reaches directly for `fetch`, `undici`, a `node:*` module, `Bun.*`, or
// `process.env` breaks the invariant — the executor can't enforce AbortSignal,
// idempotency keys, or accounting on those paths. A justified seam (the tool
// handler's injected default spawner) is marked `// handler-discipline-allow:`.
// The `sideEffect:"external"` -> `ctx.externalCall` check is AST-based and
// follows the handler's transitive relative imports, so a handler that routes its
// external call through a helper module OUTSIDE handlers/ is still recognised.
//
// Browser safety: @fragua/core's MAIN entry must stay browser-safe. This is a
// TRANSITIVE walk from `src/index.ts` over relative value imports/re-exports —
// not a directory-membership check — so a future value import from the main
// entry into a `node:`-using module (e.g. `handler/sha256.ts`) is caught even
// though that file lives under a server-only sub-entry.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allowMarked,
  type CallInfo,
  collectCalls,
  collectImports,
  collectMemberAccess,
  lineOf,
  parseSource,
  transitiveRelativeImports,
  walk,
} from "@fragua/test-utils";
import ts from "typescript";

const SRC_DIR = join(__dirname, "..", "..", "src");
const HANDLERS_DIR = join(SRC_DIR, "handler", "handlers");
const ENTRY = join(SRC_DIR, "index.ts");
const ALLOW_MARKER = "handler-discipline-allow:";
const EXTERNAL_FIXTURES = join(__dirname, "fixtures", "handler-external");

const PURE_HANDLER_FILES = ["handler/types.ts", "handler/intent-fold.ts"].map((p) => join(SRC_DIR, ...p.split("/")));

function* collect(root: string): Iterable<string> {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) yield* collect(full);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield full;
  }
}

/** A `node:*` or `undici` module reference (any import kind). */
function bannedModule(mod: string): string | undefined {
  if (mod === "undici") return "undici";
  if (mod.startsWith("node:")) return mod;
  return undefined;
}

/** A call whose callee is the `fetch` identifier or `globalThis`/`window`/`self`
 * `.fetch` — `ctx.http.fetch` (a property access on any other object) is fine. */
function isRawFetch(call: CallInfo): boolean {
  const c = call.node.expression;
  if (ts.isIdentifier(c) && c.text === "fetch") return true;
  return (
    ts.isPropertyAccessExpression(c) &&
    c.name.text === "fetch" &&
    ts.isIdentifier(c.expression) &&
    (c.expression.text === "globalThis" || c.expression.text === "window" || c.expression.text === "self")
  );
}

interface Offense {
  rule: string;
  line: number;
}

function scanHandler(sf: ts.SourceFile, includeRuntime: boolean): Offense[] {
  const out: Offense[] = [];
  for (const imp of collectImports(sf)) {
    const banned = bannedModule(imp.module);
    if (banned !== undefined && !allowMarked(sf, imp.node, ALLOW_MARKER))
      out.push({ rule: banned, line: lineOf(sf, imp.node) });
  }
  if (!includeRuntime) return out;
  for (const call of collectCalls(sf, sf)) {
    if (isRawFetch(call) && !allowMarked(sf, call.node, ALLOW_MARKER))
      out.push({ rule: "raw fetch", line: lineOf(sf, call.node) });
  }
  for (const m of collectMemberAccess(sf)) {
    if (m.objectName === "Bun" && !allowMarked(sf, m.node, ALLOW_MARKER))
      out.push({ rule: "Bun.*", line: lineOf(sf, m.node) });
    if (m.objectName === "process" && m.name === "env" && !allowMarked(sf, m.node, ALLOW_MARKER)) {
      out.push({ rule: "process.env", line: lineOf(sf, m.node) });
    }
  }
  return out;
}

function scanString(src: string, includeRuntime = true): Offense[] {
  return scanHandler(
    ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    includeRuntime,
  );
}

/** True when the file defines a handler spec literal with `sideEffect: "external"`. */
function declaresExternalSideEffect(sf: ts.SourceFile): boolean {
  let found = false;
  walk(sf, (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "sideEffect" &&
      ts.isStringLiteralLike(n.initializer) &&
      n.initializer.text === "external"
    ) {
      found = true;
    }
  });
  return found;
}

/** True when the file contains a `ctx.externalCall(...)` call. */
function usesExternalCall(sf: ts.SourceFile): boolean {
  return collectCalls(sf, sf).some((c) => {
    const e = c.node.expression;
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "externalCall" &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === "ctx"
    );
  });
}

/** A handler declaring `sideEffect:"external"` whose import graph never reaches a
 * `ctx.externalCall` — including through helper modules outside handlers/. */
function externalSideEffectOffender(file: string): boolean {
  if (!declaresExternalSideEffect(parseSource(file))) return false;
  for (const reachable of transitiveRelativeImports(file)) {
    if (usesExternalCall(parseSource(reachable))) return false;
  }
  return true;
}

describe("handler discipline", () => {
  test("no banned imports / raw fetch / Bun.* / process.env in handlers/", () => {
    const offenders: string[] = [];
    for (const file of collect(HANDLERS_DIR)) {
      for (const o of scanHandler(parseSource(file), true))
        offenders.push(`${relative(SRC_DIR, file)}:${o.line} → ${o.rule}`);
    }
    if (offenders.length > 0)
      throw new Error(`Handler discipline violations:\n${offenders.map((o) => `  ${o}`).join("\n")}`);
    expect(offenders).toHaveLength(0);
  });

  test("ctx.http.fetch is not flagged", () => {
    expect(scanString(`const r = await ctx.http.fetch("https://example.test");\n`)).toHaveLength(0);
  });

  test("bare fetch(), globalThis.fetch(), and window.fetch() are flagged", () => {
    expect(scanString(`const r = await fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
    expect(scanString(`const r = await globalThis.fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
    expect(scanString(`const r = await window.fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
  });

  test("Bun.* and process.env are flagged unless allow-marked", () => {
    expect(scanString(`const p = Bun.spawn(c);\n`).some((o) => o.rule === "Bun.*")).toBe(true);
    expect(scanString(`const v = process.env.HOME;\n`).some((o) => o.rule === "process.env")).toBe(true);
    expect(scanString(`// ${ALLOW_MARKER} injected default\nconst p = Bun.spawn(c);\n`)).toHaveLength(0);
  });

  test("node: and undici imports are flagged", () => {
    expect(scanString(`import { readFileSync } from "node:fs";\n`).some((o) => o.rule === "node:fs")).toBe(true);
    expect(scanString(`import { request } from "undici";\n`).some((o) => o.rule === "undici")).toBe(true);
    expect(scanString(`const fs = require("node:fs");\n`).some((o) => o.rule === "node:fs")).toBe(true);
  });

  test('every sideEffect:"external" handler in handlers/ uses ctx.externalCall', () => {
    const offenders: string[] = [];
    for (const file of collect(HANDLERS_DIR)) {
      if (externalSideEffectOffender(file)) offenders.push(file);
    }
    if (offenders.length > 0) {
      throw new Error(`Handlers declaring sideEffect:"external" must call ctx.externalCall:\n${offenders.join("\n")}`);
    }
    expect(offenders).toHaveLength(0);
  });

  test("external side-effect satisfied via an imported helper is not flagged", () => {
    expect(externalSideEffectOffender(join(EXTERNAL_FIXTURES, "delegated.ts"))).toBe(false);
  });

  test("external side-effect with no reachable ctx.externalCall is flagged", () => {
    expect(externalSideEffectOffender(join(EXTERNAL_FIXTURES, "missing.ts"))).toBe(true);
  });

  test("pure handler modules (types.ts, intent-fold.ts) have no I/O imports", () => {
    const offenders: string[] = [];
    for (const file of PURE_HANDLER_FILES) {
      for (const o of scanHandler(parseSource(file), false))
        offenders.push(`  ${relative(SRC_DIR, file)}:${o.line} → ${o.rule}`);
    }
    if (offenders.length > 0) throw new Error(`Pure handler modules must not import I/O:\n${offenders.join("\n")}`);
    expect(offenders).toHaveLength(0);
  });
});

/** A `node:`/`bun:`/`@fragua/store` value import that must never appear in
 * browser-reachable code. */
function browserBanned(mod: string): boolean {
  return (
    mod.startsWith("node:") || mod.startsWith("bun:") || mod === "@fragua/store" || mod.startsWith("@fragua/store/")
  );
}

describe("browser safety — main entry has no server-only imports", () => {
  test("no node:/bun:/@fragua/store value import reachable from src/index.ts", () => {
    const offenders: string[] = [];
    for (const file of transitiveRelativeImports(ENTRY)) {
      const sf = parseSource(file);
      for (const imp of collectImports(sf)) {
        if (!imp.typeOnly && browserBanned(imp.module))
          offenders.push(`  ${relative(SRC_DIR, file)}:${lineOf(sf, imp.node)} → ${imp.module}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `server-only imports reachable from the @fragua/core main entry (move the code under a` +
          ` server-only sub-entry or inject the dependency):\n${offenders.join("\n")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("the transitive walk follows re-exports and stops at server-only files", () => {
    const reachable = transitiveRelativeImports(ENTRY);
    expect(reachable).toContain(join(SRC_DIR, "routing.ts"));
    // handler/sha256.ts (node:crypto) is only reachable via the server-only
    // handler sub-entry, which the main entry never re-exports.
    expect(reachable).not.toContain(join(SRC_DIR, "handler", "sha256.ts"));
    expect(reachable).not.toContain(join(SRC_DIR, "read-plane", "projections.ts"));
  });

  test("a node: value import is flagged but a type-only @fragua/store import is not", () => {
    const flag = (src: string): boolean =>
      collectImports(ts.createSourceFile("s.ts", src, ts.ScriptTarget.Latest, true)).some(
        (i) => !i.typeOnly && browserBanned(i.module),
      );
    expect(flag(`import { readFileSync } from "node:fs";\n`)).toBe(true);
    expect(flag(`import { Database } from "bun:sqlite";\n`)).toBe(true);
    expect(flag(`import type { RunState } from "@fragua/store";\n`)).toBe(false);
  });
});
