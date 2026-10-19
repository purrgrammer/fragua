#!/usr/bin/env bun
// analyze verifier — execute every lens hypothesis's SQL check against the
// read-only window.db and decide it from the rows, never from prose.
//
// A hypothesis is falsifiable by construction: its `check` is one SELECT over
// window.db that returns a single row with an `ok` column. 1 confirms the
// claim, 0 refutes it, anything else (error, no row, no `ok` column, more
// than one row) is inconclusive. The first rows of the result are kept so the
// report can quote the deciding numbers.
//
// Inputs: one or more JSON files of hypotheses (this run's lenses) and,
// optionally, the previous run's `analyze-checks.json`, whose checks are
// re-executed under their original ids so a previous finding can move to
// `fixed`. Writes the merged ledger of checks to --ledger for the next run,
// and the typed results struct to $FRAGUA_OUTPUT.
//
//   bun .fragua/scripts/analyze/verify.ts --window .fragua/scratch/analyze/window.db \
//        --previous analyze-checks.json --ledger analyze-checks.json <hypotheses.json>...

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Hypothesis {
  id: string;
  lens?: string;
  workflow: string;
  step: string;
  claim: string;
  evidence?: string;
  check: string;
  change: string;
  confidence?: string;
  impact?: string;
}

interface Result extends Hypothesis {
  origin: "current" | "previous";
  outcome: "confirmed" | "refuted" | "inconclusive";
  rows: string;
  error: string;
}

interface Args {
  window: string;
  previous: string | null;
  ledger: string;
  files: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    window: ".fragua/scratch/analyze/window.db",
    previous: null,
    ledger: "analyze-checks.json",
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const next = argv[i + 1];
    if (a === "--window" && next) {
      out.window = next;
      i++;
    } else if (a === "--previous" && next) {
      out.previous = next;
      i++;
    } else if (a === "--ledger" && next) {
      out.ledger = next;
      i++;
    } else {
      out.files.push(a);
    }
  }
  return out;
}

function readHypotheses(path: string): Hypothesis[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (text.length === 0) return [];
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [];
  return list.filter(
    (h): h is Hypothesis =>
      typeof h === "object" &&
      h !== null &&
      typeof (h as Hypothesis).id === "string" &&
      typeof (h as Hypothesis).check === "string" &&
      typeof (h as Hypothesis).claim === "string",
  );
}

const ROW_LIMIT = 5;
const ROWS_CHARS = 600;

function execute(db: Database, check: string): { outcome: Result["outcome"]; rows: string; error: string } {
  const sql = check.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(sql) || sql.includes(";")) {
    return { outcome: "inconclusive", rows: "", error: "check must be a single SELECT/WITH statement" };
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  } catch (e) {
    return { outcome: "inconclusive", rows: "", error: e instanceof Error ? e.message : String(e) };
  }
  const shown = JSON.stringify(rows.slice(0, ROW_LIMIT)).slice(0, ROWS_CHARS);
  if (rows.length !== 1) {
    return { outcome: "inconclusive", rows: shown, error: `expected exactly one row, got ${rows.length}` };
  }
  const ok = rows[0]?.ok;
  if (ok === 1 || ok === true || ok === 1n) return { outcome: "confirmed", rows: shown, error: "" };
  if (ok === 0 || ok === false || ok === 0n) return { outcome: "refuted", rows: shown, error: "" };
  return { outcome: "inconclusive", rows: shown, error: "row has no 0/1 `ok` column" };
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.window)) {
  process.stderr.write(`verify: window db not found at ${args.window}\n`);
  process.exit(1);
}
const db = new Database(args.window, { readonly: true });

const previous = args.previous ? readHypotheses(args.previous) : [];
const current = args.files.flatMap(readHypotheses);
const seen = new Set(previous.map((h) => h.id));
// A current id that collides with a previous one gets a run-local prefix so
// both rows survive; the ledger then carries each under its own id.
const prefix = `R${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-`;
const renamed = current.map((h) => (seen.has(h.id) ? { ...h, id: `${prefix}${h.id}` } : h));

const results: Result[] = [];
for (const [origin, list] of [
  ["previous", previous],
  ["current", renamed],
] as const) {
  for (const h of list) {
    const r = execute(db, h.check);
    results.push({ ...h, origin, ...r });
  }
}
db.close();

const summary = {
  checks: results.length,
  confirmed: results.filter((r) => r.outcome === "confirmed").length,
  refuted: results.filter((r) => r.outcome === "refuted").length,
  inconclusive: results.filter((r) => r.outcome === "inconclusive").length,
  previous_rerun: previous.length,
};

// The ledger for the next run: every check executed this run, previous ones
// included, under its final id. Inconclusive checks are kept so a broken
// query gets rewritten rather than forgotten.
const ledger = results.map(({ id, lens, workflow, step, claim, check, change, confidence, impact }) => ({
  id,
  lens: lens ?? "",
  workflow,
  step,
  claim,
  check,
  change,
  confidence: confidence ?? "",
  impact: impact ?? "",
}));
writeFileSync(args.ledger, `${JSON.stringify(ledger, null, 2)}\n`);

const struct = {
  summary,
  results: results.map((r) => ({
    id: r.id,
    origin: r.origin,
    lens: r.lens ?? "",
    workflow: r.workflow,
    step: r.step,
    claim: r.claim,
    check: r.check,
    outcome: r.outcome,
    rows: r.rows,
    error: r.error,
    change: r.change,
    confidence: r.confidence ?? "",
    impact: r.impact ?? "",
  })),
};
const outPath = process.env.FRAGUA_OUTPUT;
if (outPath) writeFileSync(outPath, JSON.stringify(struct));
process.stdout.write(
  `verify: ${summary.checks} checks (${summary.previous_rerun} re-run) → ${summary.confirmed} confirmed, ${summary.refuted} refuted, ${summary.inconclusive} inconclusive\n`,
);
