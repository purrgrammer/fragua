// File-length discipline across the monorepo.
//
// Two files (store.ts, backend.ts) grew into multi-thousand-line monoliths
// where every latent bug reviews found tended to hide. After splitting them
// along their declared seams, this source-scan lint keeps every production file
// under packages/*/src (excluding packages/web and *.test.ts) at or below 800
// raw lines: a file over the ceiling fails the test unless it carries a dated
// allowlist entry. Mirrors the per-package function-length lints
// (packages/daemon|agent/test/function-length.lint.test.ts) one level up — at
// the FILE, not the function.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = join(import.meta.dir, "..", "..");
const MAX_LINES = 800;

interface AllowEntry {
  /** Path relative to packages/ (posix slashes). */
  file: string;
  /** Why this file is (temporarily) allowed over the ceiling — MUST carry a
   * date (YYYY-MM-DD) and a reason. */
  reason: string;
}

// Pre-existing oversize files pinned here with a dated reason so this lint lands
// green while still guarding every other file (including the freshly split
// backend.ts and store.ts) from regressing. `backend.ts` and `store/src/store.ts`
// must NEVER appear here — both were split along their declared seams, and a
// regression must fail the scan, not be silently allowlisted.
const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "core/src/engine/validator.ts",
    reason: "2025-06-14: pre-existing workflow validator; one exhaustive rule table, split separately.",
  },
  {
    file: "types/src/events.ts",
    reason:
      "2025-06-14: pre-existing event-contract declaration-merge surface; the taxonomy lives in one file by design.",
  },
  {
    file: "daemon/src/transition-planner.ts",
    reason:
      "2025-06-14: pre-existing pure transition planner, out of scope for the store/backend split — split separately.",
  },
  {
    file: "store/src/run-state-queries.ts",
    reason: "2025-06-14: pre-existing per-table query module (SQL audit point); out of scope for the store split.",
  },
  {
    file: "core/src/parser/yaml.ts",
    reason: "2025-06-14: pre-existing workflow YAML parser; out of scope for the store/backend split.",
  },
  {
    file: "cli/src/commands/operator.ts",
    reason: "2025-06-14: pre-existing operator-verb command surface; out of scope for the store/backend split.",
  },
  {
    file: "store/src/types.ts",
    reason:
      "2025-06-14: pre-existing store public-types + sub-interface surface; the IEventStore contract lives in one file by design.",
  },
];

/** Raw line count as an editor shows it (final newline not counted as a line). */
function lineCount(path: string): number {
  const content = readFileSync(path, "utf8");
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/** Every production .ts under a package's src/, recursively, as paths relative
 * to packages/ (posix slashes). `*.test.ts` and non-existent src/ are skipped. */
function srcFiles(pkg: string): string[] {
  const root = join(PACKAGES_DIR, pkg, "src");
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, relPath);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(`${pkg}/src/${relPath}`);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Package directories under packages/, excluding packages/web. */
function packages(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((name) => name !== "web" && statSync(join(PACKAGES_DIR, name)).isDirectory())
    .sort();
}

function allFiles(): string[] {
  return packages().flatMap(srcFiles);
}

function isAllowed(rel: string): boolean {
  return ALLOWLIST.some((a) => a.file === rel);
}

describe("file-length discipline", () => {
  test("no production file under packages/*/src (excluding packages/web) exceeds 800 lines", () => {
    const offenders: string[] = [];
    for (const rel of allFiles()) {
      const lines = lineCount(join(PACKAGES_DIR, rel));
      if (lines > MAX_LINES && !isAllowed(rel)) offenders.push(`  ${rel} (${lines} lines)`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Files over ${MAX_LINES} lines (split them, or add a dated allowlist entry):\n${offenders.join("\n")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("the completed backend split is under the ceiling and never allowlisted", () => {
    const rel = "agent/src/backend.ts";
    expect(isAllowed(rel), `${rel} must not be allowlisted`).toBe(false);
    expect(lineCount(join(PACKAGES_DIR, rel)), `${rel} over ${MAX_LINES}`).toBeLessThanOrEqual(MAX_LINES);
  });

  test("the allowlist holds only the pinned pre-existing files", () => {
    expect(ALLOWLIST.map((a) => a.file).sort()).toEqual([
      "cli/src/commands/operator.ts",
      "core/src/engine/validator.ts",
      "core/src/parser/yaml.ts",
      "daemon/src/transition-planner.ts",
      "store/src/run-state-queries.ts",
      "store/src/types.ts",
      "types/src/events.ts",
    ]);
  });

  test("every allowlist entry names a file that still exists, still exceeds the ceiling, and carries a dated reason", () => {
    for (const entry of ALLOWLIST) {
      const lines = lineCount(join(PACKAGES_DIR, entry.file));
      expect(lines, `stale allowlist entry (now under ceiling): ${entry.file}`).toBeGreaterThan(MAX_LINES);
      expect(entry.reason, `allowlist entry ${entry.file} needs a dated reason`).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  test("the scan excludes packages/web and *.test.ts, and covers the split packages", () => {
    const files = allFiles();
    expect(files.some((f) => f.startsWith("web/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
    expect(files).toContain("store/src/store.ts");
    expect(files).toContain("agent/src/backend.ts");
  });

  test("the lint counts raw lines (a 900-line file is over the ceiling)", () => {
    const body = Array.from({ length: 900 }, (_, i) => `const v${i} = ${i};`).join("\n");
    expect(body.split("\n").length).toBeGreaterThan(MAX_LINES);
  });
});
