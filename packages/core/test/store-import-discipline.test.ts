// Store-import discipline: @fragua/store is a devDependency of core and the
// dependency direction is web → server → store ← daemon → core — core's
// runtime must NEVER value-import from @fragua/store (the read plane's header
// claims "only its type is imported"; this scan makes that claim enforced,
// not prose). Type-only imports/re-exports (`import type`, `export type`)
// are fine; any value import would make core→store a real runtime edge and
// pull store's node-only code toward browser-adjacent bundles.
//
// Shape: packages/server/test/intent-plane-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Matches `import { … } from "@fragua/store"` / `export { … } from …` /
// side-effect `import "@fragua/store"`, but NOT `import type` / `export type`.
const STORE_IMPORT =
  /\b(import|export)\s+(?!type\b)[\s\S]*?from\s+["']@fragua\/store["']|import\s+["']@fragua\/store["']/;

const hits: { rel: string; statement: string }[] = [];
for (const file of walkTs(SRC_DIR)) {
  const source = readFileSync(file, "utf8");
  // Scan statement-wise: split on semicolons so multi-line import blocks are
  // captured whole and `import type {` headers exclude the entire block.
  for (const stmt of source.split(";")) {
    const m = stmt.match(STORE_IMPORT);
    if (m?.[0] != null) {
      hits.push({
        rel: file.slice(SRC_DIR.length + 1),
        statement: m[0].replace(/\s+/g, " ").trim(),
      });
    }
  }
}

describe("store-import discipline — core's runtime never imports store values", () => {
  test("no value import/export from @fragua/store anywhere in packages/core/src", () => {
    // If this fails: the value lives canonically in @fragua/types (store
    // re-exports it) — import it from there, and make the remaining store
    // names `import type { … }`.
    expect(hits).toEqual([]);
  });
});
