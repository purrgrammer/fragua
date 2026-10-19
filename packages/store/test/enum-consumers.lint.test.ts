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
//      Equality (not membership) is what catches the MISSING arm;
//   4. every quoted literal in a bare `<alias.>status <op> '…'` comparison —
//      `<op>` one of `=`, `==`, `!=`, `<>`, `IS`, `IS NOT`; predicate
//      position (`WHERE status = 'queued'`) AND assignment position
//      (`SET status = 'running'`) — must be a known RunStatus.
//      These are the dispatch-claim and crash-sweep transitions in
//      run-state-queries.ts; a renamed literal there would never match a
//      row (or would trip the CHECK only at runtime). The four predicates
//      the dispatcher and startup sweep depend on are additionally pinned
//      by name so a silent rewrite of their literals is caught.
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

/** Extract every bare `<alias.>status <op> 'literal'` comparison or assignment,
 * `<op>` one of `=`, `==`, `!=`, `<>`, `IS`, `IS NOT`. Ordering comparisons
 * (`<=` / `>=`) and `IS NULL` never match. Overlaps the CASE arms by design —
 * this check is membership only. `inbox_status` is a different enum and is
 * excluded. */
function statusEqualitySites(file: string, source: string): StatusSite[] {
  const sites: StatusSite[] = [];
  const EQ_RE = /([A-Za-z_.]*status)(?:\s*(?:==?|!=|<>)\s*|\s+IS(?:\s+NOT)?\s+)'([^']*)'/gi;
  for (const match of source.matchAll(EQ_RE)) {
    const column = match[1] ?? "";
    if (column.includes("inbox_status")) continue;
    const literal = match[2] ?? "";
    const line = source.slice(0, match.index).split("\n").length;
    sites.push({ file: relative(join(__dirname, "..", ".."), file), line, literals: [literal] });
  }
  return sites;
}

const KNOWN_STATUSES = new Set<string>(RUN_STATUSES);

/** Literals in bare `status = '…'` sites of `source` that are not a RunStatus. */
function bareEqualityOffenders(source: string): string[] {
  return statusEqualitySites("synthetic.sql", source)
    .flatMap((s) => s.literals)
    .filter((l) => !KNOWN_STATUSES.has(l));
}

/** Body of a `const NAME = `…`` SQL template in `source`. */
function sqlConstBody(source: string, name: string): string | undefined {
  return source.match(new RegExp(`const ${name} = \`([^\`]*)\``))?.[1];
}

describe("enum-literal consumers (SQL)", () => {
  const known = KNOWN_STATUSES;
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

  test("every quoted literal in a bare status = '…' predicate or SET under store/src is a known RunStatus", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const site of statusEqualitySites(file, source)) {
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

  test("pins the dispatch/sweep predicates in run-state-queries.ts", () => {
    const path = join(SRC_ROOT, "run-state-queries.ts");
    const source = readFileSync(path, "utf8");
    const literalsOf = (name: string): string[] | undefined => {
      const body = sqlConstBody(source, name);
      return body === undefined ? undefined : statusEqualitySites(path, body).flatMap((s) => s.literals);
    };
    expect({
      SELECT_NEXT_QUEUED_RUN_SQL: literalsOf("SELECT_NEXT_QUEUED_RUN_SQL"),
      CLAIM_NEXT_RUN_SQL: literalsOf("CLAIM_NEXT_RUN_SQL"),
      UPDATE_RUN_STATE_QUARANTINED_BY_SWEEP_SQL: literalsOf("UPDATE_RUN_STATE_QUARANTINED_BY_SWEEP_SQL"),
      UPDATE_RUN_STATE_REQUEUED_AFTER_CRASH_SQL: literalsOf("UPDATE_RUN_STATE_REQUEUED_AFTER_CRASH_SQL"),
      RELEASE_CLAIM_SQL: literalsOf("RELEASE_CLAIM_SQL"),
    }).toEqual({
      SELECT_NEXT_QUEUED_RUN_SQL: ["queued"],
      CLAIM_NEXT_RUN_SQL: ["running", "queued"],
      UPDATE_RUN_STATE_QUARANTINED_BY_SWEEP_SQL: ["quarantined"],
      UPDATE_RUN_STATE_REQUEUED_AFTER_CRASH_SQL: ["queued"],
      RELEASE_CLAIM_SQL: ["queued", "running"],
    });
  });

  test("flags a stale literal behind ==, !=, <>, IS and IS NOT (R3-M5)", () => {
    const sql =
      "WHERE status == 'runing' OR status != 'queud' OR r.status <> 'haltd' OR status IS 'x' OR status IS NOT 'y'";
    expect(bareEqualityOffenders(sql)).toEqual(["runing", "queud", "haltd", "x", "y"]);
  });

  test("flags status == 'runing' planted in RELEASE_CLAIM_SQL (R3-M5)", () => {
    const source = readFileSync(join(SRC_ROOT, "run-state-queries.ts"), "utf8");
    const body = sqlConstBody(source, "RELEASE_CLAIM_SQL") ?? "";
    const planted = body.replace("status = 'running'", "status == 'runing'");
    expect(planted).not.toBe(body);
    expect(bareEqualityOffenders(planted)).toEqual(["runing"]);
  });

  test("flags a renamed literal in a bare predicate the IN/CASE matchers miss", () => {
    const sql = "UPDATE run_state SET status = 'archived' WHERE status = 'queud'";
    expect(statusInSites("synthetic.sql", sql)).toEqual([]);
    expect(statusCaseSites("synthetic.sql", sql)).toEqual([]);
    expect(bareEqualityOffenders(sql)).toEqual(["archived", "queud"]);
  });

  test("does not flag inbox_status or ordering comparisons (R3-M5 control)", () => {
    expect(statusEqualitySites("synthetic.sql", "WHERE inbox_status = 'pending'")).toEqual([]);
    expect(statusEqualitySites("synthetic.sql", "WHERE rs.inbox_status='pending'")).toEqual([]);
    expect(statusEqualitySites("synthetic.sql", "WHERE inbox_status <> 'pending'")).toEqual([]);
    expect(statusEqualitySites("synthetic.sql", "WHERE status <= 'x' OR status >= 'y'")).toEqual([]);
    expect(statusEqualitySites("synthetic.sql", "WHERE status IS NULL")).toEqual([]);
  });
});
