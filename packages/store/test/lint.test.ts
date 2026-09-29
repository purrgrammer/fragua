// Structural lint — ARCHITECTURE.md §5, invariant I1.
//
// Every store write runs inside a `this.writeTxn(() => ...)` (or a raw
// `db.transaction(() => ...)`) callback whose body executes under the SQLite
// write lock. Inside that body we MUST NOT `await` (blocks the lock), serialize
// or parse JSON (allocates on the hot path under the lock), reach the network
// (`fetch`), or run a TypeBox `Value.Check`/`Value.Compile` — the caller
// pre-serializes and validates before the transaction opens.
//
// This is an AST scan (not a regex over source text): it walks the callback body
// AND, one level deep, the bodies of any function declared in the SAME file that
// the callback calls — so routing a `JSON.stringify` through a private helper no
// longer escapes the rule the way the old substring scan let it.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  callbackBodiesOf,
  collectAwaits,
  collectCalls,
  lineOf,
  parseSource,
  sameFileFunctionBodies,
} from "@fragua/test-utils";
import ts from "typescript";

const ROOTS = [join(__dirname, "..", "src"), join(__dirname, "..", "..", "daemon", "src")];

const TXN_CALLEES = ["writeTxn", "transaction"];

/** Callee text that must never appear in a transaction body. `fetch` is matched
 * by its identifier name separately. */
const BANNED_CALL_TEXT = new Set(["JSON.stringify", "JSON.parse", "Value.Check", "Value.Compile"]);

interface Offender {
  file: string;
  kind: string;
  line: number;
}

function collectSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Scan one node (a transaction body or an inlined helper body) for the banned
 * constructs, excluding nested deferred functions. */
function scanBody(body: ts.Node, sf: ts.SourceFile, file: string): Offender[] {
  const offenders: Offender[] = [];
  for (const a of collectAwaits(body)) offenders.push({ file, kind: "await", line: lineOf(sf, a) });
  for (const call of collectCalls(body, sf, true)) {
    if (call.name === "fetch") offenders.push({ file, kind: "fetch", line: lineOf(sf, call.node) });
    else if (BANNED_CALL_TEXT.has(call.text)) offenders.push({ file, kind: call.text, line: lineOf(sf, call.node) });
  }
  return offenders;
}

function scanFile(file: string): Offender[] {
  const sf = parseSource(file);
  const helpers = sameFileFunctionBodies(sf);
  const offenders: Offender[] = [];
  for (const body of callbackBodiesOf(sf, TXN_CALLEES)) {
    offenders.push(...scanBody(body, sf, file));
    // One level of same-file helper inlining: a function declared in this file
    // and called directly in the txn body runs under the same lock.
    const seen = new Set<string>();
    for (const call of collectCalls(body, sf, true)) {
      const helperBody = helpers.get(call.name);
      if (helperBody !== undefined && !seen.has(call.name)) {
        seen.add(call.name);
        offenders.push(...scanBody(helperBody, sf, file));
      }
    }
  }
  return offenders;
}

// invariant: I1 — every store write is one txn; no await / JSON serialization /
// fetch / TypeBox check may run inside a txn body. Load-bearing sentinel for
// daemon/test/invariant-coverage.test.ts.
describe("I1 — no serialization / IO inside transaction bodies", () => {
  test("no offenders in store + daemon src", () => {
    const offenders: Offender[] = [];
    for (const root of ROOTS) {
      for (const file of collectSources(root)) offenders.push(...scanFile(file));
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} → ${o.kind} in txn body`).join("\n");
      throw new Error(`I1 violations found:\n${msg}`);
    }
    expect(offenders).toHaveLength(0);
  });

  const scanSynthetic = (src: string): Offender[] => {
    const sf = ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const helpers = sameFileFunctionBodies(sf);
    const out: Offender[] = [];
    for (const body of callbackBodiesOf(sf, TXN_CALLEES)) {
      out.push(...scanBody(body, sf, "synthetic.ts"));
      const seen = new Set<string>();
      for (const call of collectCalls(body, sf, true)) {
        const helperBody = helpers.get(call.name);
        if (helperBody !== undefined && !seen.has(call.name)) {
          seen.add(call.name);
          out.push(...scanBody(helperBody, sf, "synthetic.ts"));
        }
      }
    }
    return out;
  };

  test("catches await / fetch / JSON.parse directly in a txn callback", () => {
    const src = `this.writeTxn(() => { const x = JSON.parse(s); fetch(u); });`;
    const kinds = scanSynthetic(src).map((o) => o.kind);
    expect(kinds).toContain("JSON.parse");
    expect(kinds).toContain("fetch");
  });

  test("catches JSON.stringify reached through a same-file helper", () => {
    const src = `
      function ser(p) { return JSON.stringify(p); }
      this.writeTxn(() => { insert(ser(payload)); });
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toContain("JSON.stringify");
  });

  test("does not flag serialization inside a nested deferred callback", () => {
    // An event listener registered inside the txn runs later, not under the lock.
    const src = `this.writeTxn(() => { on("x", () => JSON.stringify(y)); });`;
    expect(scanSynthetic(src)).toHaveLength(0);
  });

  test("does not inline a second level of helper", () => {
    // `a` calls `b`; only `a`'s own body is scanned when the txn calls `a`.
    const src = `
      function b() { return JSON.stringify(z); }
      function a() { return b(); }
      this.writeTxn(() => { a(); });
    `;
    expect(scanSynthetic(src)).toHaveLength(0);
  });
});
