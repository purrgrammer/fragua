// IEventStore sub-interface discipline (types.ts § segregated store
// interfaces): the composite `IEventStore` is a convenience alias for the
// six concern-scoped sub-interfaces (IEventWriter / IEventReader /
// IAnalyticsReader / IDaemonCoordinator / IProviderCredentialStore /
// IProviderConfigStore). Consumers must type their `store` seam against the
// narrowest slice (or intersection) they actually call — never the full
// composite. This scan fails the build if a parameter or property in any
// `packages/*/src` OUTSIDE `packages/store` is annotated `: IEventStore`, so
// the split is enforced, not merely documented in prose.
//
// This is an AST scan (not a regex over source text): it resolves file-local
// `type` aliases to their underlying type before matching, so a `type S =
// IEventStore; store: S` indirection — invisible to the old per-line regex — is
// caught, as is a line-broken annotation.
//
// Allowed by construction:
//   - `import { type IEventStore }` — pulling the alias to build a `Pick<>`
//     (the makeGraphLoader precedent) or to hand it out from an assembly seam.
//   - `Pick<IEventStore, …>` / `Omit<IEventStore, …>` — an explicit slice
//     (the composite appears only as a type argument, never descended into).
//   - The assembly seams that construct the real store and fan narrow slices
//     out to sub-typed consumers (server entrypoint, daemon entrypoint, CLI
//     store-client / executor-deps).
//   - `packages/store` itself (SqliteStore implements the composite).
//
// Shape: packages/server/test/intent-plane-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { lineOf, parseSource, resolveTypeAliases, walk } from "@fragua/test-utils";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/store/test
const COMPOSITE = "IEventStore";

/** Assembly seams that legitimately hold the full composite to hand narrow
 *  slices out to sub-typed consumers. Repo-relative, posix slashes. */
const EXEMPT = new Set<string>([
  "packages/server/src/index.ts",
  "packages/daemon/src/entrypoint.ts",
  "packages/cli/src/store-client.ts",
  "packages/cli/src/executor-deps.ts",
]);

/** True when `typeNode` is — or resolves through file-local aliases /
 * intersections to — the bare composite. A `Pick<IEventStore, …>` is a
 * TypeReference named `Pick`; its type arguments are never descended into, so a
 * slice is allowed while `IEventStore` / `A & IEventStore` / an alias for either
 * is flagged. */
function hitsComposite(typeNode: ts.TypeNode, aliases: Map<string, ts.TypeNode>, seen: Set<string>): boolean {
  if (ts.isParenthesizedTypeNode(typeNode)) return hitsComposite(typeNode.type, aliases, seen);
  if (ts.isIntersectionTypeNode(typeNode)) return typeNode.types.some((t) => hitsComposite(t, aliases, seen));
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    if (name === COMPOSITE) return true;
    const alias = aliases.get(name);
    if (alias !== undefined && !seen.has(name)) {
      seen.add(name);
      return hitsComposite(alias, aliases, seen);
    }
  }
  return false;
}

/** Every annotation position that binds a `store` seam: parameters, class /
 * interface properties, and variables. */
function annotationTypes(sf: ts.SourceFile): ts.TypeNode[] {
  const out: ts.TypeNode[] = [];
  walk(sf, (n) => {
    if (
      (ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isVariableDeclaration(n)) &&
      n.type !== undefined
    ) {
      out.push(n.type);
    }
  });
  return out;
}

function scan(sf: ts.SourceFile): { line: number; text: string }[] {
  const aliases = resolveTypeAliases(sf);
  const out: { line: number; text: string }[] = [];
  for (const t of annotationTypes(sf)) {
    if (hitsComposite(t, aliases, new Set())) out.push({ line: lineOf(sf, t), text: t.getText(sf) });
  }
  return out;
}

function scanString(src: string): { line: number; text: string }[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const packagesDir = join(ROOT, "packages");
const srcDirs = readdirSync(packagesDir)
  .filter((pkg) => pkg !== "store")
  .map((pkg) => join(packagesDir, pkg, "src"))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

const hits: { rel: string; line: number; text: string }[] = [];
for (const dir of srcDirs) {
  for (const file of walkTs(dir)) {
    const rel = file
      .slice(ROOT.length + 1)
      .split("\\")
      .join("/");
    if (EXEMPT.has(rel)) continue;
    for (const h of scan(parseSource(file))) hits.push({ rel, line: h.line, text: h.text });
  }
}

describe("IEventStore sub-interface split — no full-composite annotations outside @fragua/store", () => {
  test("no bare IEventStore-typed param/property outside store, except declared assembly seams", () => {
    // If this fails: re-type the `store` seam against the narrowest
    // sub-interface (or intersection) it actually calls — IEventWriter /
    // IEventReader / IAnalyticsReader / IDaemonCoordinator / the provider
    // stores — or a `Pick<IEventReader, …>`. Only the four assembly seams in
    // EXEMPT may hold the composite.
    expect(hits).toEqual([]);
  });

  test("flags a bare IEventStore through a type alias", () => {
    expect(scanString(`type S = IEventStore;\nfunction f(store: S) {}\n`).length).toBe(1);
    expect(scanString(`class C { store!: IEventStore; }\n`).length).toBe(1);
    expect(scanString(`function f(store: IEventWriter & IEventStore) {}\n`).length).toBe(1);
  });

  test("still allows Pick<IEventStore,…> and type-only import", () => {
    expect(scanString(`function f(store: Pick<IEventStore, "getState">) {}\n`)).toEqual([]);
    expect(scanString(`import { type IEventStore } from "@fragua/store";\n`)).toEqual([]);
    expect(scanString(`function f(store: IEventReader) {}\n`)).toEqual([]);
  });
});
