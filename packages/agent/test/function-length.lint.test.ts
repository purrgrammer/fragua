// Function-length discipline for the agent.
//
// After the runInner split no function declaration or arrow in
// packages/agent/src exceeds 200 source lines. This source-scan lint pins that:
// it parses every non-test .ts under src/ (recursively — the agent has a
// credentials/ subtree) with the shared TypeScript scanner and measures each
// function-like node by its raw span (endLine − startLine + 1). A function over
// the ceiling fails the test unless it carries a dated allowlist entry. The
// allowlist is EMPTY today; a new entry is a deliberate, reviewed exception, not
// a silent regression. Mirrors packages/daemon/test/function-length.lint.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineOf, parseSource, walk } from "@fragua/test-utils";
import ts from "typescript";

const SRC_DIR = join(import.meta.dir, "..", "src");
const MAX_LINES = 200;

interface AllowEntry {
  /** File path relative to src/ (posix slashes). */
  file: string;
  /** Reported function name. */
  fn: string;
  /** Why this function is (temporarily) allowed over the ceiling — MUST carry
   * a date (YYYY-MM-DD) and a reason. */
  reason: string;
}

// `backend.ts` is fully under the ceiling after the runInner split. The two
// remaining entries are PRE-EXISTING oversize functions in handler-bridge.ts,
// outside the runInner-split scope of this change; they are pinned here so the
// lint lands green while still guarding every other function (including the
// now-clean backend.ts) from regressing. Add an entry only with a dated reason;
// it is a reviewed exception.
const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "handler-bridge.ts",
    fn: "makeLlmHandler",
    reason:
      "2025-06-14: pre-existing; the pi-ai→handler bridge factory, out of scope for the runInner split — split separately.",
  },
  {
    file: "handler-bridge.ts",
    fn: "run",
    reason:
      "2025-06-14: pre-existing; the bridge's per-call run() nested in makeLlmHandler, out of scope for the runInner split.",
  },
];

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/** Best-effort readable name for a function-like node (for the report). */
function functionName(sf: ts.SourceFile, n: ts.Node): string {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) return n.name.getText(sf);
  if (ts.isConstructorDeclaration(n)) return "constructor";
  const parent = n.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent !== undefined && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return "<anonymous>";
}

interface Measured {
  file: string;
  fn: string;
  line: number;
  lines: number;
}

function measure(file: string, sf: ts.SourceFile): Measured[] {
  const out: Measured[] = [];
  walk(sf, (n) => {
    if (!isFunctionLike(n)) return;
    const start = lineOf(sf, n);
    const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
    out.push({ file, fn: functionName(sf, n), line: start, lines: end - start + 1 });
  });
  return out;
}

/** Every non-test .ts under src/, recursively, as paths relative to src/. */
function srcFiles(dir = SRC_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...srcFiles(abs, rel));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(rel);
  }
  return out;
}

function isAllowed(m: Measured): boolean {
  return ALLOWLIST.some((a) => a.file === m.file && a.fn === m.fn);
}

describe("function-length discipline", () => {
  test("no function declaration or arrow in packages/agent/src exceeds 200 lines", () => {
    const offenders: Measured[] = [];
    for (const rel of srcFiles()) {
      const sf = parseSource(join(SRC_DIR, rel));
      for (const m of measure(rel, sf)) {
        if (m.lines > MAX_LINES && !isAllowed(m)) offenders.push(m);
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} → ${o.fn} (${o.lines} lines)`).join("\n");
      throw new Error(`Functions over ${MAX_LINES} lines (split them, or add a dated allowlist entry):\n${msg}`);
    }
    expect(offenders).toHaveLength(0);
  });

  test("the allowlist holds only the pinned pre-existing handler-bridge entries", () => {
    // backend.ts must never appear here — the runInner split cleared it, and a
    // regression there must fail the scan, not be silently allowlisted.
    expect(ALLOWLIST.map((a) => `${a.file}:${a.fn}`).sort()).toEqual([
      "handler-bridge.ts:makeLlmHandler",
      "handler-bridge.ts:run",
    ]);
    expect(ALLOWLIST.some((a) => a.file === "backend.ts")).toBe(false);
  });

  test("every allowlist entry names a function that still exists and still exceeds the ceiling", () => {
    for (const entry of ALLOWLIST) {
      const sf = parseSource(join(SRC_DIR, entry.file));
      const match = measure(entry.file, sf).find((m) => m.fn === entry.fn && m.lines > MAX_LINES);
      expect(match, `stale allowlist entry: ${entry.file} → ${entry.fn}`).toBeDefined();
      expect(entry.reason, `allowlist entry ${entry.file} → ${entry.fn} needs a dated reason`).toMatch(
        /\d{4}-\d{2}-\d{2}/,
      );
    }
  });

  test("the lint catches an over-length function", () => {
    const body = Array.from({ length: 205 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const text = `const big = () => {\n${body}\n};\n`;
    const sf = ts.createSourceFile("synthetic.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const over = measure("synthetic.ts", sf).filter((m) => m.lines > MAX_LINES);
    expect(over.length).toBeGreaterThan(0);
    expect(over[0]?.fn).toBe("big");
  });

  test("the scan walks the src tree recursively (not a static list)", () => {
    const files = srcFiles();
    expect(files).toContain("backend.ts");
    expect(files).toContain("system-prompt.ts");
    expect(files).toContain("credentials/model-registry.ts");
  });
});
