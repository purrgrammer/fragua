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
//      intentional subsets — membership only);
//   3. the union of literals across all `… WHEN status = '…'` CASE arms
//      under packages/store/src must EQUAL the RunStatus set — no stale,
//      no missing. A pivot that fans run_state into one column per status
//      (the /analytics Runs chart) would otherwise silently grow a zero
//      column when a new status is added, with no compiler signal: the
//      SQL hardcodes the arms and the row type carries no `satisfies`.
//      Equality (not membership) is what catches the MISSING arm.
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

interface StatusSite {
  file: string;
  line: number;
  literals: string[];
}

/** Extract every `status IN ( … )` clause (multi-line tolerated) and the
 * quoted literals inside it. Parameterized clauses (`IN (?,?)`) yield no
 * literals and are skipped. `inbox_status IN (…)` is a different enum and
 * is excluded by the word boundary on `status` plus an explicit guard. */
function statusInSites(file: string, source: string): StatusSite[] {
  const sites: StatusSite[] = [];
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

/** Extract every `WHEN <alias.>status = 'literal'` CASE arm and the quoted
 * literal it compares against. Covers the analytics pivots that fan
 * run_state into one numeric column per status. `inbox_status` is a
 * different enum and is excluded. */
function statusCaseSites(file: string, source: string): StatusSite[] {
  const sites: StatusSite[] = [];
  const ARM_RE = /\bWHEN\s+([A-Za-z_.]*status)\s*=\s*'([^']*)'/gi;
  for (const match of source.matchAll(ARM_RE)) {
    const column = match[1] ?? "";
    if (column.includes("inbox_status")) continue;
    const literal = match[2] ?? "";
    const line = source.slice(0, match.index).split("\n").length;
    sites.push({ file: relative(join(__dirname, "..", ".."), file), line, literals: [literal] });
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

  test("the union of `WHEN status = '…'` CASE arms under store/src equals the RunStatus set", () => {
    const seen = new Set<string>();
    const stale: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const site of statusCaseSites(file, source)) {
        for (const literal of site.literals) {
          seen.add(literal);
          if (!known.has(literal)) {
            stale.push(
              `${site.file}:${site.line} — '${literal}' is not a RunStatus (see RUN_STATUSES in @fragua/types)`,
            );
          }
        }
      }
    }
    const missing = RUN_STATUSES.filter((s) => !seen.has(s));
    expect(
      { stale, missing },
      "status CASE-WHEN pivots drifted from RUN_STATUSES (@fragua/types): a missing status would" +
        " silently yield a zero analytics column — update the pivot in store/src/analytics-queries.ts",
    ).toEqual({ stale: [], missing: [] });
  });
});
