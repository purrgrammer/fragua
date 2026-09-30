// Read-plane fs discipline — ARCHITECTURE.md §5.
//
// The read plane projects run_state + the event log into wire DTOs; it is a
// pure read surface over the store. A `node:fs` SYNC call (existsSync / statSync
// / readFileSync / writeFileSync), a blocking `node:fs/promises` /
// `node:child_process` import, a raw `fetch`, or a `Bun.*` reach buries I/O
// inside a projection that every read client fans out through — the cost is
// invisible at the callsite and the data belongs in the store, not the
// filesystem or the network. Any genuine exception carries the
// `read-discipline-allow:` marker so the bypass is auditable.
//
// This is an AST scan (not a regex over source text). It resolves import aliases
// to the imported symbol, so `import { existsSync as e }; e(p)` is caught the
// same as a direct `existsSync(p)` — a rename can no longer slip a forbidden call
// past the rule. Shape mirrors packages/core/test/handler/discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allowMarked,
  collectCalls,
  collectImports,
  collectMemberAccess,
  importBindings,
  lineOf,
  parseSource,
} from "@fragua/test-utils";
import ts from "typescript";

const READ_PLANE_DIR = join(import.meta.dir, "..", "..", "src", "read-plane");
const ALLOW_MARKER = "read-discipline-allow:";
const BANNED_SYNC_FS = new Set(["existsSync", "statSync", "readFileSync", "writeFileSync"]);
const BANNED_MODULES = new Set(["node:child_process", "node:fs/promises"]);

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") && !isTestFile(p)) out.push(p);
  }
  return out;
}

interface Offense {
  rule: string;
  line: number;
}

/** A raw `fetch` reach: the `fetch` identifier or `globalThis`/`window`/`self`
 * `.fetch` — a property access `ctx.http.fetch` on any other object is fine. */
function isRawFetch(node: ts.CallExpression): boolean {
  const c = node.expression;
  if (ts.isIdentifier(c) && c.text === "fetch") return true;
  return (
    ts.isPropertyAccessExpression(c) &&
    c.name.text === "fetch" &&
    ts.isIdentifier(c.expression) &&
    (c.expression.text === "globalThis" || c.expression.text === "window" || c.expression.text === "self")
  );
}

function scan(sf: ts.SourceFile): Offense[] {
  const out: Offense[] = [];
  const binds = importBindings(sf);
  for (const call of collectCalls(sf, sf)) {
    const expr = call.node.expression;
    let canonical = call.name;
    if (ts.isIdentifier(expr)) {
      const b = binds.get(expr.text);
      if (b !== undefined && b.imported !== "*") canonical = b.imported;
    }
    if (BANNED_SYNC_FS.has(canonical) && !allowMarked(sf, call.node, ALLOW_MARKER))
      out.push({ rule: canonical, line: lineOf(sf, call.node) });
    else if (isRawFetch(call.node) && !allowMarked(sf, call.node, ALLOW_MARKER))
      out.push({ rule: "fetch", line: lineOf(sf, call.node) });
  }
  for (const m of collectMemberAccess(sf)) {
    if (m.objectName === "Bun" && !allowMarked(sf, m.node, ALLOW_MARKER))
      out.push({ rule: "Bun.*", line: lineOf(sf, m.node) });
  }
  for (const imp of collectImports(sf)) {
    if (BANNED_MODULES.has(imp.module) && !allowMarked(sf, imp.node, ALLOW_MARKER))
      out.push({ rule: imp.module, line: lineOf(sf, imp.node) });
  }
  return out;
}

function scanString(src: string): Offense[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

describe("read-plane fs discipline — no node:fs / network I/O in projections", () => {
  test("no fs sync / fetch / Bun.* / blocking-module import in packages/core/src/read-plane outside the marker", () => {
    const offenders: string[] = [];
    for (const file of walkTs(READ_PLANE_DIR)) {
      for (const o of scan(parseSource(file)))
        offenders.push(`${relative(READ_PLANE_DIR, file)}:${o.line} → ${o.rule}`);
    }
    if (offenders.length > 0)
      throw new Error(`read-plane fs discipline violations:\n${offenders.map((o) => `  ${o}`).join("\n")}`);
    expect(offenders).toHaveLength(0);
  });

  test("flags existsSync, statSync, and readFileSync in a projection", () => {
    expect(scanString(`function f(p) { return existsSync(p); }\n`).some((o) => o.rule === "existsSync")).toBe(true);
    expect(scanString(`function f(p) { return statSync(p).isFile(); }\n`).some((o) => o.rule === "statSync")).toBe(
      true,
    );
    expect(scanString(`function f(p) { return readFileSync(p); }\n`).some((o) => o.rule === "readFileSync")).toBe(true);
  });

  test("flags an aliased existsSync import", () => {
    const src = `import { existsSync as e } from "node:fs";\nfunction f(p) { return e(p); }\n`;
    expect(scanString(src).some((o) => o.rule === "existsSync")).toBe(true);
  });

  test("flags fetch, writeFileSync, Bun.*, and node:child_process / node:fs/promises imports", () => {
    expect(scanString(`function f(u) { return fetch(u); }\n`).some((o) => o.rule === "fetch")).toBe(true);
    expect(
      scanString(`import { writeFileSync } from "node:fs";\nfunction f(p) { writeFileSync(p, ""); }\n`).some(
        (o) => o.rule === "writeFileSync",
      ),
    ).toBe(true);
    expect(scanString(`const p = Bun.spawn(c);\n`).some((o) => o.rule === "Bun.*")).toBe(true);
    expect(
      scanString(`import { spawn } from "node:child_process";\n`).some((o) => o.rule === "node:child_process"),
    ).toBe(true);
    expect(
      scanString(`import { readFile } from "node:fs/promises";\n`).some((o) => o.rule === "node:fs/promises"),
    ).toBe(true);
  });

  test("honors the read-discipline-allow marker", () => {
    expect(scanString(`// ${ALLOW_MARKER} probe\nfunction f(p) { return existsSync(p); }\n`)).toHaveLength(0);
    expect(scanString(`function f(p) { return existsSync(p); } // ${ALLOW_MARKER} probe\n`)).toHaveLength(0);
  });
});
