// IEventStore sub-interface discipline (types.ts § segregated store
// interfaces): the composite `IEventStore` is a convenience alias for the
// six concern-scoped sub-interfaces (IEventWriter / IEventReader /
// IAnalyticsReader / IDaemonCoordinator / IProviderCredentialStore /
// IProviderConfigStore). Consumers must type their `store` seam against the
// narrowest slice (or intersection) they actually call — never the full
// composite. This source-scan fails the build if a parameter or property in
// any `packages/*/src` OUTSIDE `packages/store` is annotated `: IEventStore`,
// so the split is enforced, not merely documented in prose.
//
// Allowed by construction:
//   - `import { type IEventStore }` — pulling the alias to build a `Pick<>`
//     (the makeGraphLoader precedent) or to hand it out from an assembly seam.
//   - `Pick<IEventStore, …>` / `Omit<IEventStore, …>` — an explicit slice.
//   - The assembly seams that construct the real store and fan narrow slices
//     out to sub-typed consumers (server entrypoint, daemon entrypoint, CLI
//     store-client / executor-deps).
//   - `packages/store` itself (SqliteStore implements the composite).
//
// Shape: packages/server/test/intent-plane-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", ".."); // repo root from packages/store/test

/** Assembly seams that legitimately hold the full composite to hand narrow
 *  slices out to sub-typed consumers. Repo-relative, posix slashes. */
const EXEMPT = new Set<string>([
  "packages/server/src/index.ts",
  "packages/daemon/src/entrypoint.ts",
  "packages/cli/src/store-client.ts",
  "packages/cli/src/executor-deps.ts",
]);

/** A bare-composite type annotation: `: IEventStore` or `& IEventStore` /
 *  `IEventStore &` (intersection member), with a word boundary so
 *  `IEventStoreFoo` and `Pick<IEventStore, …>` (preceded by `<`) don't match. */
const COMPOSITE_ANNOTATION = /(?::\s*|&\s*)IEventStore\b|\bIEventStore\s*&/;

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
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (COMPOSITE_ANNOTATION.test(text)) hits.push({ rel, line: i + 1, text: text.trim() });
      });
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
});
