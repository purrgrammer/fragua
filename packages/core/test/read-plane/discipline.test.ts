// Read-plane fs discipline — ARCHITECTURE.md §5.
//
// The read plane projects run_state + the event log into wire DTOs; it is a
// pure read surface over the store. A `node:fs` SYNC call (existsSync / statSync
// / readFileSync) buries a blocking syscall inside a projection that every read
// client fans out through — the cost is invisible at the callsite and the data
// belongs in the store, not the filesystem. Any genuine exception carries the
// `read-discipline-allow:` marker so the bypass is auditable.
//
// This is an AST scan (not a regex over source text), so a forbidden call can't
// slip past by renaming or aliasing. Shape mirrors
// packages/core/test/handler/discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { allowMarked, collectCalls, lineOf, parseSource } from "@fragua/test-utils";
import ts from "typescript";

const READ_PLANE_DIR = join(import.meta.dir, "..", "..", "src", "read-plane");
const ALLOW_MARKER = "read-discipline-allow:";
const BANNED_SYNC_FS = new Set(["existsSync", "statSync", "readFileSync"]);

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

function scan(sf: ts.SourceFile): Offense[] {
  const out: Offense[] = [];
  for (const call of collectCalls(sf, sf)) {
    if (BANNED_SYNC_FS.has(call.name) && !allowMarked(sf, call.node, ALLOW_MARKER)) {
      out.push({ rule: call.name, line: lineOf(sf, call.node) });
    }
  }
  return out;
}

function scanString(src: string): Offense[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

describe("read-plane fs discipline — no node:fs sync calls in projections", () => {
  test("no existsSync / statSync / readFileSync in packages/core/src/read-plane outside the marker", () => {
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

  test("honors the read-discipline-allow marker", () => {
    expect(scanString(`// ${ALLOW_MARKER} probe\nfunction f(p) { return existsSync(p); }\n`)).toHaveLength(0);
    expect(scanString(`function f(p) { return existsSync(p); } // ${ALLOW_MARKER} probe\n`)).toHaveLength(0);
  });
});
