// Store-import discipline: @fragua/store is a devDependency of core and the
// dependency direction is web → server → store ← daemon → core — core's
// runtime must NEVER value-import from @fragua/store (the read plane's header
// claims "only its type is imported"; this scan makes that claim enforced,
// not prose). Type-only imports/re-exports (`import type`, `export type`)
// are fine; any value import would make core→store a real runtime edge and
// pull store's node-only code toward browser-adjacent bundles.
//
// This is an AST scan (not a regex over source text): `collectImports` reports
// every module reference — static `import`/`export … from`, side-effect
// `import "…"`, dynamic `import()`, and `require()` — with its type-only flag,
// so no unanticipated import form can slip past a regex that only knew about
// one shape. Shape mirrors packages/core/test/handler/discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { collectImports, lineOf, parseSource } from "@fragua/test-utils";
import ts from "typescript";

const SRC_DIR = join(import.meta.dir, "..", "src");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** A non-type value import/reference to @fragua/store or one of its sub-entries. */
function isStoreValueImport(module: string, typeOnly: boolean): boolean {
  if (typeOnly) return false;
  return module === "@fragua/store" || module.startsWith("@fragua/store/");
}

interface Hit {
  rel: string;
  module: string;
  kind: string;
  line: number;
}

function scan(sf: ts.SourceFile): { module: string; kind: string; line: number }[] {
  const out: { module: string; kind: string; line: number }[] = [];
  for (const imp of collectImports(sf)) {
    if (isStoreValueImport(imp.module, imp.typeOnly))
      out.push({ module: imp.module, kind: imp.kind, line: lineOf(sf, imp.node) });
  }
  return out;
}

function scanString(src: string): { module: string; kind: string; line: number }[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

const hits: Hit[] = [];
for (const file of walkTs(SRC_DIR)) {
  const rel = file.slice(SRC_DIR.length + 1);
  for (const h of scan(parseSource(file))) hits.push({ rel, ...h });
}

describe("store-import discipline — core's runtime never imports store values", () => {
  test("no value import/export from @fragua/store anywhere in packages/core/src", () => {
    // If this fails: the value lives canonically in @fragua/types (store
    // re-exports it) — import it from there, and make the remaining store
    // names `import type { … }`.
    expect(hits).toEqual([]);
  });

  test("flags value / export-from / require / dynamic-import forms the regex could miss but not import type", () => {
    expect(scanString(`import { Store } from "@fragua/store";\n`).map((h) => h.module)).toContain("@fragua/store");
    expect(scanString(`export { Store } from "@fragua/store";\n`).map((h) => h.module)).toContain("@fragua/store");
    expect(scanString(`import "@fragua/store";\n`).map((h) => h.module)).toContain("@fragua/store");
    expect(scanString(`const s = require("@fragua/store");\n`).map((h) => h.module)).toContain("@fragua/store");
    expect(scanString(`const s = import("@fragua/store");\n`).map((h) => h.module)).toContain("@fragua/store");
    expect(scanString(`import { Reader } from "@fragua/store/read";\n`).map((h) => h.module)).toContain(
      "@fragua/store/read",
    );
    expect(scanString(`import type { RunState } from "@fragua/store";\n`)).toEqual([]);
    expect(scanString(`export type { RunState } from "@fragua/store";\n`)).toEqual([]);
  });
});
