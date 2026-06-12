// Design-discipline gate: enforces Fragua token hygiene across product
// surfaces. Mirrors the approach used by store/test/lint.test.ts and
// core/test/handler/discipline.test.ts.
//
// Rules:
//   1. Shadcn colour utilities (`bg-card`, `border-border`, `bg-background`,
//      `text-foreground`, `text-muted-foreground`) are reserved for shadcn
//      primitive internals under `components/ui/` (shadcn-generated files).
//      Product surfaces must use `sw-*` tokens instead.
//
//   2. Tailwind palette colour classes that name a specific hue
//      (`text-amber-*`, `bg-rose-*`, `text-emerald-*`, etc.) must not
//      appear on product surfaces. Use `text-sw-accent-*` instead.
//
// Allowlist:
//   EXEMPT_DIRS  — whole directories of shadcn-generated primitives and
//                  ai-elements, correct by design; matched by path prefix.
//   EXEMPT_FILES — explicit per-file extras, matched by exact relative path.
//   Never bare substring — a product file whose path merely CONTAINS an
//   exempt name must not be silently exempt.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

// Shadcn-generated primitives + ai-elements: tokens are correct here by
// design. Exempting the directories themselves means new shadcn primitives
// are covered without hand-listing.
const EXEMPT_DIRS = ["components/ui", "components/ai-elements"];

const EXEMPT_FILES = new Set([
  // DaemonBanner uses amber for an OS-level warning outside normal state accents.
  "components/DaemonBanner.tsx",
]);

function relPath(filePath: string): string {
  return relative(SRC, filePath).split(sep).join("/");
}

function isExempt(filePath: string): boolean {
  const rel = relPath(filePath);
  if (EXEMPT_FILES.has(rel)) return true;
  return EXEMPT_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

function collectTsxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsxFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts"))) {
      results.push(full);
    }
  }
  return results;
}

const allFiles = collectTsxFiles(SRC);
const productFiles = allFiles.filter((f) => !isExempt(f));

// Shadcn colour utilities that belong on shadcn primitives only.
const SHADCN_COLOUR_PATTERN =
  /\b(bg-card|bg-background|bg-muted|text-foreground|text-muted-foreground|border-border|text-card-foreground|bg-popover|text-popover-foreground)\b/;

// Tailwind named-hue palette classes that should be replaced with sw-* tokens.
const PALETTE_COLOUR_PATTERN =
  /\b(?:text|bg|border|ring|fill|stroke)-(?:amber|rose|emerald|red|green|blue|yellow|orange|purple|pink|cyan|teal|indigo|violet|slate|stone|zinc|neutral|gray)-\d{2,3}\b/;

describe("design discipline", () => {
  test("exemption covers components/ui contents by path, never bare substring", () => {
    const uiFiles = readdirSync(join(SRC, "components", "ui"));
    expect(uiFiles.length).toBeGreaterThan(0);
    for (const name of uiFiles) {
      expect(isExempt(join(SRC, "components", "ui", name))).toBe(true);
    }
    expect(isExempt(join(SRC, "routes", "components", "ui", "fake.tsx"))).toBe(false);
    expect(isExempt(join(SRC, "components", "DaemonBannerCopy.tsx"))).toBe(false);
  });

  test("product surfaces use sw-* tokens, not shadcn colour utilities", () => {
    const violations: string[] = [];
    for (const file of productFiles) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (SHADCN_COLOUR_PATTERN.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("product surfaces use sw-* accent tokens, not Tailwind palette hues", () => {
    const violations: string[] = [];
    for (const file of productFiles) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (PALETTE_COLOUR_PATTERN.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
