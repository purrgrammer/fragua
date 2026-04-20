// Structural lint — REARCHITECTURE.md §5, invariant I1.
//
// The store module wraps every write in `db.transaction(() => ...)` or the
// equivalent BEGIN IMMEDIATE / COMMIT pair. Inside those bodies we MUST NOT
// await or serialize JSON — both would either block the write lock (await)
// or allocate on the hot path under the write lock (JSON.stringify). The
// rule is enforced by grepping the source tree for either pattern inside
// the body of a txn-like block.
//
// This isn't a full AST parse — it's a conservative regex over the source
// files in packages/store/src and packages/daemon/src. False positives get
// caught via a small allowlist keyed off the file path.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(__dirname, "..", "src"), join(__dirname, "..", "..", "daemon", "src")];

/** Files we trust to break the rule because they never run inside a txn. */
const ALLOWLIST = new Set<string>([
  // none at present — add with a reason when needed
]);

function collectSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Extract text between a `.transaction(` and its matching `)` / the
 * paired `BEGIN IMMEDIATE` and `COMMIT` lines. Very coarse — keyed on
 * the common shapes used in this codebase.
 */
function* txnBodies(source: string): IterableIterator<string> {
  // Shape A: .transaction(() => { ... })()
  const TXN_RE = /\.transaction\s*\(\s*\(\s*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = TXN_RE.exec(source)) != null) {
    const start = match.index + match[0].length;
    const end = matchBrace(source, start - 1);
    if (end > start) yield source.slice(start, end);
  }
  // Shape B: BEGIN IMMEDIATE ... COMMIT wrapped in a try block
  const BEGIN = /this\.db\.exec\(\s*["']BEGIN IMMEDIATE["']\s*\)[^]*?this\.db\.exec\(\s*["']COMMIT["']\s*\)/g;
  while ((match = BEGIN.exec(source)) != null) {
    yield match[0];
  }
  // Shape C: db.exec("BEGIN IMMEDIATE") ... db.exec("COMMIT") via free db var
  const BEGIN2 = /\bdb\.exec\(\s*["']BEGIN IMMEDIATE["']\s*\)[^]*?\bdb\.exec\(\s*["']COMMIT["']\s*\)/g;
  while ((match = BEGIN2.exec(source)) != null) {
    yield match[0];
  }
}

function matchBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

describe("I1 — no await / JSON.stringify inside transaction bodies", () => {
  const offenders: { file: string; snippet: string; kind: string }[] = [];
  for (const root of ROOTS) {
    for (const file of collectSources(root)) {
      if (ALLOWLIST.has(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const body of txnBodies(src)) {
        if (/\bawait\b/.test(body)) {
          offenders.push({ file, snippet: body.slice(0, 120), kind: "await" });
        }
        if (/\bJSON\.stringify\s*\(/.test(body)) {
          offenders.push({
            file,
            snippet: body.slice(0, 120),
            kind: "JSON.stringify",
          });
        }
      }
    }
  }

  test("no offenders", () => {
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}: ${o.kind} in txn body\n    ${o.snippet}`).join("\n");
      throw new Error(`I1 violations found:\n${msg}`);
    }
    expect(offenders).toHaveLength(0);
  });
});
