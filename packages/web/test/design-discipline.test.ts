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
//   CLEAN_PATHS  — shadcn-generated primitives and ai-elements, correct by design.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// Shadcn-generated files + ai-elements: tokens are correct here by design.
const CLEAN_PATHS_CONTAINING = [
  "components/ui/avatar",
  "components/ui/badge",
  "components/ui/button",
  "components/ui/card",
  "components/ui/input",
  "components/ui/separator",
  "components/ui/sidebar",
  "components/ui/tabs",
  "components/ui/tooltip",
  "components/ui/select",
  "components/ui/popover",
  "components/ui/dialog",
  "components/ui/scroll-area",
  "components/ui/progress",
  "components/ui/alert",
  "components/ui/breadcrumb",
  "components/ui/hover-card",
  "components/ui/collapsible",
  "components/ui/dropdown-menu",
  "components/ui/command",
  "components/ui/input-group",
  "components/ui/button-group",
  "components/ui/table",
  "components/ui/spinner",
  "components/ui/textarea",
  "components/ui/chart",
  "components/ui/sheet",
  "components/ai-elements",
  // DaemonBanner uses amber for an OS-level warning outside normal state accents.
  "components/DaemonBanner",
];

function isExempt(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return CLEAN_PATHS_CONTAINING.some((p) => norm.includes(p));
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
