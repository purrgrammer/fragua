// Inline-import discipline (AGENTS.md ground rule 6): all `import`s live at
// file top — no dynamic `import(…)` or `require(…)` inside functions in
// production source. Test files (*.test.ts / *.test.tsx) are exempt: mock
// isolation requires import-after-mock. The documented escape for a
// genuinely-circular module graph is the marker `// inline-import-allow: <reason>`
// on the offending line or the line above it.
//
// This is an AST scan: it catches dynamic `import(...)`, `import(...).then(...)`,
// and `require(...)` (the old regex only matched `await import(`), scans
// `packages/*/src` AND `packages/cli/bin`, and does NOT flag a type-position
// `import("x").Y` (an ImportTypeNode carries no runtime import).

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { allowMarked, collectImports, lineOf, parseSource } from "@fragua/test-utils";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/server/test
const PACKAGES_DIR = join(ROOT, "packages");
const ALLOW_MARKER = "inline-import-allow:";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

function scan(sf: ts.SourceFile): { line: number; kind: string }[] {
  const out: { line: number; kind: string }[] = [];
  for (const imp of collectImports(sf)) {
    if (imp.kind === "static") continue;
    if (allowMarked(sf, imp.node, ALLOW_MARKER)) continue;
    out.push({ line: lineOf(sf, imp.node), kind: imp.kind });
  }
  return out;
}

function scanString(src: string): { line: number; kind: string }[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const SCAN_DIRS = [
  ...readdirSync(PACKAGES_DIR).map((name) => join(PACKAGES_DIR, name, "src")),
  join(PACKAGES_DIR, "cli", "bin"),
].filter(isDir);

describe("inline-import discipline — no dynamic import()/require() in production source", () => {
  test("scans every packages/*/src directory and packages/cli/bin", () => {
    expect(SCAN_DIRS.length).toBeGreaterThanOrEqual(10);
    expect(SCAN_DIRS).toContain(join(PACKAGES_DIR, "cli", "bin"));
  });

  test("no dynamic import() / require() outside test files", () => {
    // If this fails: hoist the import to file top. For a genuinely-circular
    // module graph, add `// inline-import-allow: <why the cycle exists>` on
    // the line or the line above.
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walkTs(dir)) {
        if (isTestFile(file)) continue;
        for (const hit of scan(parseSource(file)))
          offenders.push(`${file.slice(ROOT.length + 1)}:${hit.line} (${hit.kind})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("catches dynamic import(), import().then(), and require()", () => {
    expect(scanString(`async function f() { const m = await import("./x.ts"); }\n`)).toEqual([
      { line: 1, kind: "dynamic" },
    ]);
    expect(scanString(`function f() { import("./x.ts").then(m => m); }\n`)).toEqual([{ line: 1, kind: "dynamic" }]);
    expect(scanString(`function f() { const m = require("./x.ts"); }\n`)).toEqual([{ line: 1, kind: "require" }]);
  });

  test("does not flag a type-position import(...)", () => {
    expect(scanString(`type T = import("@fragua/types").AnyEventType;\n`)).toEqual([]);
    expect(scanString(`import type { X } from "./x.ts";\n`)).toEqual([]);
  });

  test("honors the inline-import-allow marker", () => {
    expect(scanString(`const m = await import("./x.ts"); // inline-import-allow: cycle with y.ts\n`)).toEqual([]);
    expect(scanString(`// inline-import-allow: cycle with y.ts\nconst m = await import("./x.ts");\n`)).toEqual([]);
  });
});
