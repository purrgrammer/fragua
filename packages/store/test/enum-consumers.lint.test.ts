// Enum-literal consumer lint (CLAUDE.md ground rule 1) — SQL sites.
//
// SQL strings can't import the RUN_STATUSES tuple from @fragua/types, so
// they are the one consumer class where drift after adding/removing a
// RunStatus literal is invisible to the compiler. This test pins them by
// source scan:
//
//   1. the `run_state.status` CHECK in schema.sql must list EXACTLY the
//      RunStatus literals (no stale, no missing);
//   2. every quoted literal inside any `status IN (…)` clause under
//      packages/store/src must be a known RunStatus (these clauses are
//      intentional subsets — membership only).
//
// Conservative regex, same spirit as lint.test.ts (invariant I1). Scanning
// the whole src tree means new SQL sites are covered the moment they exist.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RUN_STATUSES } from "@fragua/types";

const SRC_ROOT = join(__dirname, "..", "src");

function collectSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".ts") || name.endsWith(".sql")) out.push(full);
    }
  };
  walk(root);
  return out;
}

interface StatusInSite {
  file: string;
  line: number;
  literals: string[];
}

/** Extract every `status IN ( … )` clause (multi-line tolerated) and the
 * quoted literals inside it. Parameterized clauses (`IN (?,?)`) yield no
 * literals and are skipped. `inbox_status IN (…)` is a different enum and
 * is excluded by the word boundary on `status` plus an explicit guard. */
function statusInSites(file: string, source: string): StatusInSite[] {
  const sites: StatusInSite[] = [];
  const CLAUSE_RE = /([A-Za-z_.]*status)\s+IN\s*\(([^)]*)\)/gi;
  for (const match of source.matchAll(CLAUSE_RE)) {
    const column = match[1] ?? "";
    if (column.includes("inbox_status")) continue;
    const body = match[2] ?? "";
    const literals = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
    if (literals.length === 0) continue;
    const line = source.slice(0, match.index).split("\n").length;
    sites.push({ file: relative(join(__dirname, "..", ".."), file), line, literals });
  }
  return sites;
}

describe("enum-literal consumers (SQL)", () => {
  const known = new Set<string>(RUN_STATUSES);
  const sources = collectSources(SRC_ROOT);

  test("schema.sql run_state.status CHECK lists exactly the RunStatus literals", () => {
    const schemaPath = join(SRC_ROOT, "schema.sql");
    const schema = readFileSync(schemaPath, "utf8");
    const match = schema.match(/CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)/i);
    expect(match, "store/src/schema.sql: run_state.status CHECK clause not found").not.toBeNull();
    const line = schema.slice(0, match!.index).split("\n").length;
    const listed = new Set([...(match![1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1] ?? ""));
    const stale = [...listed].filter((l) => !known.has(l));
    const missing = RUN_STATUSES.filter((s) => !listed.has(s));
    expect(
      { stale, missing },
      `store/src/schema.sql:${line} run_state.status CHECK drifted from RUN_STATUSES (@fragua/types)`,
    ).toEqual({ stale: [], missing: [] });
  });

  test("every quoted literal in a status IN (…) clause under store/src is a known RunStatus", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const site of statusInSites(file, source)) {
        for (const literal of site.literals) {
          if (!known.has(literal)) {
            offenders.push(
              `${site.file}:${site.line} — '${literal}' is not a RunStatus (see RUN_STATUSES in @fragua/types)`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
