// SQL-location discipline — backend skill principle 2: every SQL statement lives
// in a `<domain>-queries.ts` module (the single audit point for what the database
// is asked and the only place a column rename has to land). This lint scans the
// string / template literals (via the AST, so SQL keywords in comments don't
// count) of every `packages/store/src` module and fails on DML/DQL outside a
// `*-queries.ts` file — except a small, named allowlist of maintenance sites.
//
// VACUUM / PRAGMA / DROP TABLE / BEGIN / COMMIT / SAVEPOINT are transaction and
// maintenance control, not table DML, and are not flagged anywhere.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSource, walk } from "@fragua/test-utils";
import ts from "typescript";

const SRC_DIR = join(__dirname, "..", "src");

/** Non-`*-queries.ts` files permitted to hold SQL, each with a reason. */
const ALLOWLIST = new Map<string, string>([
  ["sweep.ts", "crash-recovery heal runs its own SAVEPOINT DML/DQL"],
  ["migrations.ts", "schema DDL + schema_version bookkeeping"],
  ["store.ts", "backup/scrub maintenance: sqlite_master introspection + table drops"],
]);

/** Table DML/DQL that must be centralised in a `*-queries.ts`. */
const SQL_RE =
  /\b(SELECT\s|INSERT\s+INTO\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|CREATE\s+INDEX\b|UPDATE\s+[\w".]+\s+SET\b)/i;

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function sqlLiteralLines(sf: ts.SourceFile): number[] {
  const out: number[] = [];
  walk(sf, (n) => {
    if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      if (SQL_RE.test(n.getText(sf))) out.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
  });
  return out;
}

function scanString(src: string): number[] {
  return sqlLiteralLines(ts.createSourceFile("s.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

describe("SQL lives in *-queries.ts", () => {
  test("no DML/DQL outside *-queries.ts (allowlisted maintenance excepted)", () => {
    const offenders: string[] = [];
    for (const file of collectSources(SRC_DIR)) {
      const base = file.slice(SRC_DIR.length + 1);
      const name = base.split("/").at(-1) ?? base;
      if (name.endsWith("-queries.ts") || ALLOWLIST.has(name)) continue;
      for (const line of sqlLiteralLines(parseSource(file))) offenders.push(`  ${base}:${line}`);
    }
    if (offenders.length > 0) {
      throw new Error(
        `SQL outside a *-queries.ts module (move the statement into the matching` +
          ` <domain>-queries.ts, or add a named allowlist entry with a reason):\n${offenders.join("\n")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("the allowlist names only files that exist", () => {
    const present = new Set(readdirSync(SRC_DIR));
    for (const name of ALLOWLIST.keys()) expect(present.has(name)).toBe(true);
  });

  test("catches an inlined SELECT in a non-queries file", () => {
    expect(scanString("const rows = db.query(`SELECT * FROM run_state`).all();\n")).toEqual([1]);
    expect(scanString('db.query("INSERT INTO x (a) VALUES (?)").run(1);\n')).toEqual([1]);
  });

  test("does not flag SQL that appears only in a comment", () => {
    expect(scanString("// DELETE FROM daemon_lock WHERE id = 1\nconst x = 1;\n")).toHaveLength(0);
  });

  test("does not flag VACUUM / PRAGMA maintenance", () => {
    expect(scanString('db.exec("VACUUM");\ndb.exec("PRAGMA journal_mode = WAL");\n')).toHaveLength(0);
  });
});
