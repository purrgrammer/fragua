// SQL-location discipline — backend skill principle 2: every SQL statement lives
// in a `<domain>-queries.ts` module (the single audit point for what the database
// is asked and the only place a column rename has to land). This lint scans the
// string / template literals (via the AST, so SQL keywords in comments don't
// count) of every `packages/store/src` module and fails on DML/DQL outside a
// `*-queries.ts` file — except a small, named allowlist of maintenance sites.
// Conflict-clause forms (`INSERT OR … INTO`, `UPDATE OR … SET`, `REPLACE INTO`)
// and CTE-led statements (`WITH x AS (`) count as DML/DQL too.
//
// A `+` chain of literal operands is folded into one string before testing, so
// `"SEL" + "ECT …"` is caught; a non-literal operand ends the fold. Keywords
// match at `\b` boundaries, so `SELECT*FROM x` (no whitespace) counts.
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
const ALLOWLIST = new Map<string, string>([["migrations.ts", "schema DDL + schema_version bookkeeping"]]);

/** Table DML/DQL that must be centralised in a `*-queries.ts`. */
const SQL_RE =
  /\b(SELECT\b|INSERT(?:\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO\b|REPLACE\s+INTO\b|DELETE\s+FROM\b|CREATE\s+TABLE\b|CREATE\s+INDEX\b|UPDATE\s+[\w".]+\s+SET\b|UPDATE\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+[\w".]+\s+SET\b|WITH\s+(?:RECURSIVE\s+)?\w+\s+AS\s*\()/i;

const CONFLICT_FIXTURE = join(__dirname, "fixtures", "sql-location", "conflict-clauses.ts");
const CONCAT_FIXTURE = join(__dirname, "fixtures", "sql-location", "concat.ts");
const NO_SPACE_FIXTURE = join(__dirname, "fixtures", "sql-location", "no-space.ts");

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function skipParens(n: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(n) ? skipParens(n.expression) : n;
}

function isPlus(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Operands of a `+` chain, left to right, through parentheses. */
function plusOperands(n: ts.Expression): ts.Expression[] {
  const e = skipParens(n);
  return isPlus(e) ? [...plusOperands(e.left), ...plusOperands(e.right)] : [e];
}

/** True for the outermost `+` of a chain (its parent, through parentheses, is
 * not itself a `+`). */
function isChainRoot(n: ts.BinaryExpression): boolean {
  let parent = n.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return !isPlus(parent);
}

/** Text a literal operand contributes to a concatenation; undefined for a
 * non-literal operand. */
function literalText(n: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.getText(sf).slice(1, -1);
  return undefined;
}

/** Each maximal run of adjacent literal operands in the chain, joined. */
function foldedRuns(chain: ts.BinaryExpression, sf: ts.SourceFile): string[] {
  const runs: string[] = [];
  let run: string | undefined;
  for (const operand of plusOperands(chain)) {
    const text = literalText(operand, sf);
    if (text === undefined) {
      if (run !== undefined) runs.push(run);
      run = undefined;
    } else run = (run ?? "") + text;
  }
  if (run !== undefined) runs.push(run);
  return runs;
}

function sqlLiteralLines(sf: ts.SourceFile): number[] {
  const out = new Set<number>();
  const lineOfNode = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  walk(sf, (n) => {
    if (ts.isStringLiteralLike(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      if (SQL_RE.test(n.getText(sf))) out.add(lineOfNode(n));
    } else if (isPlus(n) && isChainRoot(n)) {
      if (foldedRuns(n, sf).some((s) => SQL_RE.test(s))) out.add(lineOfNode(n));
    }
  });
  return [...out].sort((a, b) => a - b);
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
    expect(scanString('db.query("INSERT OR REPLACE INTO x (a) VALUES (?)").run(1);\n')).toEqual([1]);
    expect(scanString('db.query("INSERT OR IGNORE INTO x (a) VALUES (?)").run(1);\n')).toEqual([1]);
    expect(scanString('db.query("UPDATE OR ABORT x SET a = ?").run(1);\n')).toEqual([1]);
    expect(scanString('db.query("REPLACE INTO x (a) VALUES (?)").run(1);\n')).toEqual([1]);
  });

  test("flags UPDATE OR <conflict> … SET, REPLACE INTO, and WITH … AS ( CTEs", () => {
    expect(sqlLiteralLines(parseSource(CONFLICT_FIXTURE))).toEqual([6, 7, 8, 9, 10, 11]);
  });

  test("sweep.ts is not on the SQL allowlist", () => {
    // The crash-recovery sweep routes every INSERT/UPDATE/SELECT through the
    // *-queries.ts modules; reintroducing raw DML there must be caught, not
    // exempted by a whole-file allowlist entry.
    expect(ALLOWLIST.has("sweep.ts")).toBe(false);
  });

  test("flags a raw INSERT INTO events reintroduced into a non-queries file", () => {
    const src =
      "db.query(`INSERT INTO events (run_id, seq, type, writer, payload, ts)" +
      " VALUES (?, ?, 'fact.run_quarantined', 'daemon', ?, ?)`).run(r, s, p, t);\n";
    expect(scanString(src)).toEqual([1]);
  });

  test("flags a SELECT split across a + concatenation (R2-M2)", () => {
    expect(sqlLiteralLines(parseSource(CONCAT_FIXTURE))).toEqual([6]);
  });

  test("flags SELECT* with no whitespace after the keyword (R2-M2)", () => {
    expect(sqlLiteralLines(parseSource(NO_SPACE_FIXTURE))).toEqual([6]);
  });

  test("reports a matching concat chain once", () => {
    expect(scanString('const q = "SELECT a " + "FROM t";\n')).toEqual([1]);
  });

  test("a non-literal operand breaks the fold", () => {
    expect(scanString('const q = "SEL" + x + "ECT * FROM t";\n')).toHaveLength(0);
  });

  test('does not flag "selected"', () => {
    expect(scanString('const label = "selected rows";\n')).toHaveLength(0);
  });

  test("does not flag SQL that appears only in a comment", () => {
    expect(scanString("// DELETE FROM daemon_lock WHERE id = 1\nconst x = 1;\n")).toHaveLength(0);
  });

  test("does not flag VACUUM / PRAGMA maintenance", () => {
    expect(scanString('db.exec("VACUUM");\ndb.exec("PRAGMA journal_mode = WAL");\n')).toHaveLength(0);
  });
});
