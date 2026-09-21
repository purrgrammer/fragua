// Bundle discipline: @fragua/web reaches into @fragua/core's store-pulling
// sub-entries (`./read-plane`, `./intent-plane`, `./handler`) for DTO types
// only. Those entries value-export runtime code — `read-plane/projections.ts`
// imports `node:fs` — so a VALUE import would drag node built-ins into the
// browser bundle. `import type` is erased by esbuild before the specifier is
// ever resolved, which is the only reason this is safe today.
//
// The hazard is silent: `read-plane/schemas.ts` exports RunSummary/RunDetail/
// NodeState/SelectedEdge as TypeBox consts as well as types, so an IDE
// auto-import drops the `type` keyword and still compiles.
//
// Shape: packages/server/test/dependency-discipline.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const FORBIDDEN = ["@fragua/core/read-plane", "@fragua/core/intent-plane", "@fragua/core/handler"];
const ROOT = join(import.meta.dirname, "..", "..", "..", ".."); // repo root from packages/web/test/lib
const SRC_DIR = join(ROOT, "packages/web/src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// Group 2 captures the `type` keyword for type-only clauses; a mixed
// `import { type A, B }` clause has no top-level `type` and is correctly
// flagged as a value import.
const FROM_RE = /\b(import|export)\s+(type\s)?[^;]*?from\s+["']([^"']+)["']/g;
const BARE_RE = /\bimport\s+["']([^"']+)["']/g;

const hits: { rel: string; spec: string }[] = [];
for (const file of walkTs(SRC_DIR)) {
  const rel = file.slice(ROOT.length + 1);
  const content = readFileSync(file, "utf8");
  for (const m of content.matchAll(FROM_RE)) {
    if (m[2] === undefined && FORBIDDEN.includes(m[3] ?? "")) hits.push({ rel, spec: m[3] ?? "" });
  }
  for (const m of content.matchAll(BARE_RE)) {
    if (FORBIDDEN.includes(m[1] ?? "")) hits.push({ rel, spec: m[1] ?? "" });
  }
}

describe("bundle discipline — @fragua/core's server-side entries are type-only in web src", () => {
  test("no value import of a store-pulling core sub-entry", () => {
    // If this fails: add the `type` keyword. Those entries pull node:fs.
    expect(hits).toEqual([]);
  });
});
