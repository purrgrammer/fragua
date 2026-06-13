// Dependency discipline: @fragua/server carries no pi-ai or @fragua/agent
// runtime dependency. Provider-aware capabilities (model validation, the
// 1-token provider probe, the default-model map) are injected by the CLI
// assembly through `ServerOptions` — see `validateWorkflowModels` /
// `testProvider` / `defaultModels`. Type-only imports are fine (erased at
// runtime); a VALUE import from either package would put pi-ai back in the
// server bundle, so this scan fails the build on one.
//
// Shape: packages/server/test/intent-plane-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["@earendil-works/pi-ai", "@fragua/agent"];
const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/server/test
const SRC_DIR = join(ROOT, "packages/server/src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Matches `import … from "<spec>"` / `export … from "<spec>"` (including
// multi-line clauses) and bare side-effect imports `import "<spec>"`.
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

describe("dependency discipline — no pi-ai / @fragua/agent value imports in server src", () => {
  test("provider capabilities flow through the injected ServerOptions seam", () => {
    // If this fails: inject the capability through `ServerOptions`
    // (constructed by the CLI assembly) instead of importing it here.
    expect(hits).toEqual([]);
  });
});
