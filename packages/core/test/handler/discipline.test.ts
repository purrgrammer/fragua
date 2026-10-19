// Handler discipline + browser safety — ARCHITECTURE.md §5.
//
// Handlers receive their I/O through HandlerContext (ctx.llm, ctx.http,
// ctx.tools, ctx.messages, ctx.artifacts, ctx.externalCall). A handler that
// reaches directly for `fetch`, `undici`, a `node:*` or bare Node builtin module
// (`fs`, `child_process`, …), a computed `import()`/`require()`, `Bun.*`,
// `process.env`, or the global object itself (`globalThis`) breaks the
// invariant — the executor can't enforce AbortSignal, idempotency keys, or
// accounting on those paths. Reaches are matched after the shared
// `normalizeCallee`, so a global receiver (`globalThis.process.env`,
// `self.fetch`), a local alias (`const p = process`) or a destructuring
// (`const { spawn } = Bun`) is caught like the plain form, while a local binding
// that shadows a receiver name (`const window = …`) is not. A justified seam
// (the tool handler's injected default spawner) is marked
// `// handler-discipline-allow:`.
// Both checks are AST-based and follow each handler's transitive relative
// imports: the I/O ban reaches a helper module OUTSIDE handlers/ that a handler
// delegates its `fetch` / `node:fs` / `Bun.*` call to, and the
// `sideEffect:"external"` -> `ctx.externalCall` check recognises an external
// call routed through such a helper.
//
// Browser safety: @fragua/core's MAIN entry must stay browser-safe. This is a
// TRANSITIVE walk from `src/index.ts` over relative value imports/re-exports —
// not a directory-membership check — so a future value import from the main
// entry into a `node:`-using module (e.g. `handler/sha256.ts`) is caught even
// though that file lives under a server-only sub-entry.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import {
  allowMarked,
  type CallInfo,
  collectCalls,
  collectImports,
  DYNAMIC_SPECIFIER,
  lineOf,
  normalizeCallee,
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
const IO_FIXTURES = join(__dirname, "fixtures", "handler-io");

const PURE_HANDLER_FILES = ["handler/types.ts", "handler/intent-fold.ts"].map((p) => join(SRC_DIR, ...p.split("/")));

function* collect(root: string): Iterable<string> {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) yield* collect(full);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield full;
  }
}

/** A `node:*`, bare-builtin (`fs`), `undici`, or computed-specifier module
 * reference (any import kind). */
function bannedModule(mod: string): string | undefined {
  if (mod === DYNAMIC_SPECIFIER) return mod;
  if (mod === "undici") return "undici";
  if (mod.startsWith("node:")) return mod;
  if (!mod.startsWith(".") && !mod.startsWith("/") && isBuiltin(mod)) return mod;
  return undefined;
}

/** A call whose callee normalises to the global `fetch` — `ctx.http.fetch` (a
 * property access on any other object) is fine. */
function isRawFetch(call: CallInfo): boolean {
  const chain = normalizeCallee(call.node.expression)?.chain;
  return chain?.length === 1 && chain[0] === "fetch";
}

interface Offense {
  rule: string;
  line: number;
}

type Access = ts.PropertyAccessExpression | ts.ElementAccessExpression;
type Wrapper = ts.ParenthesizedExpression | ts.NonNullExpression | ts.AsExpression | ts.SatisfiesExpression;

function isAccess(n: ts.Node): n is Access {
  return ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
}

function isWrapper(n: ts.Node): n is Wrapper {
  return (
    ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)
  );
}

/** The nearest ancestor that is not a parenthesis / assertion wrapper, and the
 * child it was reached from. */
function unwrappedParent(n: ts.Node): { parent: ts.Node; child: ts.Node } {
  let child = n;
  let parent = n.parent;
  while (isWrapper(parent)) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
}

/** True when `n` is a receiver extended by a member access (`n.x`, `n[k]`). */
function isAccessReceiver(n: ts.Node): boolean {
  const { parent, child } = unwrappedParent(n);
  return isAccess(parent) && parent.expression === child;
}

function chainRoot(n: ts.Expression): ts.Expression {
  let e = n;
  while (isAccess(e) || isWrapper(e)) e = e.expression;
  return e;
}

function isGlobalThisId(n: ts.Node): boolean {
  return ts.isIdentifier(n) && n.text === "globalThis";
}

/** `globalThis` in value position, outside a member-access chain (which is
 * judged as a whole) and outside type queries. */
function isBareGlobalThis(n: ts.Node): boolean {
  if (!isGlobalThisId(n) || isAccessReceiver(n)) return false;
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isPropertyAssignment(p) && p.name === n) return false;
  return !ts.isQualifiedName(p) && !ts.isTypeQueryNode(p);
}

/** The rule a normalised reach breaks: `Bun.*` or `process.env`. */
function reachRule(chain: string[] | undefined): string | undefined {
  if (chain?.[0] === "Bun") return "Bun.*";
  if (chain?.[0] === "process" && chain[1] === "env") return "process.env";
  return undefined;
}

/** Names bound by an object destructuring, as their declaring identifiers. */
function patternIdentifiers(pattern: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(pattern)) return [pattern];
  const out: ts.Identifier[] = [];
  for (const el of pattern.elements) if (ts.isBindingElement(el)) out.push(...patternIdentifiers(el.name));
  return out;
}

/** `Bun.*` / `process.env` / `globalThis` reaches: each outermost member-access
 * chain yields at most one offense (`Bun.*` over `process.env` over a
 * `globalThis` root), plus bare `globalThis` references and object
 * destructurings off `Bun` / `process.env`. */
function globalReachOffenses(sf: ts.SourceFile): Offense[] {
  const out: Offense[] = [];
  const push = (rule: string | undefined, node: ts.Node): void => {
    if (rule !== undefined && !allowMarked(sf, node, ALLOW_MARKER)) out.push({ rule, line: lineOf(sf, node) });
  };
  walk(sf, (n) => {
    if (isAccess(n) && !isAccessReceiver(n)) {
      const rule = reachRule(normalizeCallee(n)?.chain) ?? (isGlobalThisId(chainRoot(n)) ? "globalThis" : undefined);
      push(rule, n);
    } else if (isBareGlobalThis(n)) {
      push("globalThis", n);
    } else if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name)) {
      for (const id of patternIdentifiers(n.name)) push(reachRule(normalizeCallee(id)?.chain), id);
    }
  });
  return out;
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
  out.push(...globalReachOffenses(sf));
  return out;
}

function scanString(src: string, includeRuntime = true): Offense[] {
  return scanHandler(
    ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    includeRuntime,
  );
}

/** Every I/O-ban offense reachable from a handler module through its relative
 * value imports, keyed by the offending file — so a handler can't launder a
 * banned call through a helper outside handlers/. */
function handlerIoOffenses(file: string): Array<{ file: string; offense: Offense }> {
  const out: Array<{ file: string; offense: Offense }> = [];
  for (const reachable of transitiveRelativeImports(file)) {
    for (const offense of scanHandler(parseSource(reachable), true)) out.push({ file: reachable, offense });
  }
  return out;
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
  test("no banned imports / raw fetch / Bun.* / process.env reachable from handlers/", () => {
    const offenders = new Set<string>();
    for (const file of collect(HANDLERS_DIR)) {
      for (const { file: where, offense } of handlerIoOffenses(file))
        offenders.add(`${relative(SRC_DIR, where)}:${offense.line} → ${offense.rule}`);
    }
    if (offenders.size > 0)
      throw new Error(`Handler discipline violations:\n${[...offenders].map((o) => `  ${o}`).join("\n")}`);
    expect(offenders.size).toBe(0);
  });

  test("a banned import delegated to a helper outside the handler file is flagged", () => {
    const offenses = handlerIoOffenses(join(IO_FIXTURES, "delegating.ts"));
    expect(offenses.map((o) => o.offense.rule)).toEqual(["node:fs"]);
    expect(offenses[0]?.file.endsWith("helper.ts")).toBe(true);
  });

  test("a raw fetch / Bun.* delegated to a helper outside the handler file is flagged", () => {
    const offenses = handlerIoOffenses(join(IO_FIXTURES, "fetching.ts"));
    expect(offenses.map((o) => o.offense.rule)).toEqual(["raw fetch", "Bun.*"]);
    expect(offenses.every((o) => o.file.endsWith("fetch-helper.ts"))).toBe(true);
  });

  test("ctx.http.fetch is not flagged", () => {
    expect(scanString(`const r = await ctx.http.fetch("https://example.test");\n`)).toHaveLength(0);
  });

  test("bare fetch(), globalThis.fetch(), and window.fetch() are flagged", () => {
    expect(scanString(`const r = await fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
    expect(scanString(`const r = await globalThis.fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
    expect(scanString(`const r = await window.fetch(u);\n`).some((o) => o.rule === "raw fetch")).toBe(true);
  });

  test("globalThis.process.env and globalThis.Bun.spawn delegated to a helper are flagged (R3-M3)", () => {
    const offenses = handlerIoOffenses(join(IO_FIXTURES, "global-receiver.ts"));
    expect(offenses.map((o) => o.offense.rule)).toEqual(["process.env", "Bun.*"]);
    expect(offenses.every((o) => o.file.endsWith("global-helper.ts"))).toBe(true);
  });

  test("aliased and destructured process / Bun / fetch are flagged", () => {
    const rules = (src: string): string[] => scanString(src).map((o) => o.rule);
    expect(rules(`const p = process;\nconst v = p.env.X;\n`)).toEqual(["process.env"]);
    expect(rules(`const { env } = process;\n`)).toEqual(["process.env"]);
    expect(rules(`const { spawn } = Bun;\n`)).toEqual(["Bun.*"]);
    expect(rules(`const f = fetch;\nconst r = f(u);\n`)).toEqual(["raw fetch"]);
  });

  test("any globalThis reference is flagged", () => {
    expect(scanString(`const c = globalThis.structuredClone(x);\n`).map((o) => o.rule)).toEqual(["globalThis"]);
    expect(scanString(`const g = globalThis;\n`).map((o) => o.rule)).toEqual(["globalThis"]);
  });

  test("a local window and ctx-scoped env / Bun / fetch are not flagged (R3-M3 control)", () => {
    const src = `const window = pick();\nwindow.fetch(u);\nconst h = ctx.env.HOME;\ndeps.Bun.spawn(c);\nctx.http.fetch(u);\n`;
    expect(scanString(src)).toEqual([]);
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
    expect(scanString(`import { spawn } from "child_process";\n`).some((o) => o.rule === "child_process")).toBe(true);
    expect(scanString(`import { readFile } from "fs/promises";\n`).some((o) => o.rule === "fs/promises")).toBe(true);
    expect(scanString(`import * as YAML from "yaml";\nimport { x } from "./x.ts";\n`)).toHaveLength(0);
    expect(scanString(`// ${ALLOW_MARKER} injected default\nimport { readFileSync } from "fs";\n`)).toHaveLength(0);
  });

  test("a bare Node builtin import (fs) delegated from a handler is flagged", () => {
    const offenses = handlerIoOffenses(join(IO_FIXTURES, "bare-builtin.ts"));
    expect(offenses.map((o) => o.offense.rule)).toEqual(["fs"]);
  });

  test("template-literal and computed dynamic imports are flagged", () => {
    const offenses = handlerIoOffenses(join(IO_FIXTURES, "dynamic-specifier.ts"));
    expect(offenses.map((o) => o.offense.rule)).toEqual(["node:fs", DYNAMIC_SPECIFIER]);
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
