// Inline-import discipline (AGENTS.md ground rule 6): all `import`s live at
// file top — no `await import(…)` inside functions in production src/. Test
// files (*.test.ts / *.test.tsx) are exempt: mock isolation requires
// import-after-mock. The documented escape for a genuinely-circular module
// graph is the marker `// inline-import-allow: <reason>` on the offending
// line or the line above it.
//
// Shape: intent-plane-discipline.test.ts (cross-package source scan from the
// server test dir).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/server/test
const PACKAGES_DIR = join(ROOT, "packages");
const ALLOW_MARKER = "inline-import-allow:";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test.tsx");
}

function scanInlineImports(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!/\bawait\s+import\s*\(/.test(line)) continue;
    if (line.includes(ALLOW_MARKER)) continue;
    if (i > 0 && lines[i - 1]!.includes(ALLOW_MARKER)) continue;
    hits.push(i + 1);
  }
  return hits;
}

const SCAN_DIRS = readdirSync(PACKAGES_DIR)
  .map((name) => join(PACKAGES_DIR, name, "src"))
  .filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

describe("inline-import discipline — no await import() in production src", () => {
  test("scans every packages/*/src directory", () => {
    expect(SCAN_DIRS.length).toBeGreaterThanOrEqual(9);
  });

  test("no inline await import() outside test files", () => {
    // If this fails: hoist the import to file top. For a genuinely-circular
    // module graph, add `// inline-import-allow: <why the cycle exists>` on
    // the line or the line above.
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walkTs(dir)) {
        if (isTestFile(file)) continue;
        const src = readFileSync(file, "utf8");
        for (const line of scanInlineImports(src)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("lint catches a bare inline await import", () => {
    expect(scanInlineImports(`async function f() {\n  const m = await import("./x.ts");\n}\n`)).toEqual([2]);
  });

  test("lint honors the inline-import-allow marker", () => {
    const sameLine = `const m = await import("./x.ts"); // inline-import-allow: cycle with y.ts\n`;
    expect(scanInlineImports(sameLine)).toEqual([]);
    const lineAbove = `// inline-import-allow: cycle with y.ts\nconst m = await import("./x.ts");\n`;
    expect(scanInlineImports(lineAbove)).toEqual([]);
  });

  test("lint ignores commented-out inline imports", () => {
    expect(scanInlineImports(`// const m = await import("./x.ts");\n`)).toEqual([]);
  });
});
