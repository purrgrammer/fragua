// Structural lint — ARCHITECTURE.md §5, invariant I1.
//
// Every store write runs inside a `this.writeTxn(() => ...)` (or a raw
// `db.transaction(() => ...)`) callback whose body executes under the SQLite
// write lock. A `SAVEPOINT`-wrapped closure (the startup sweep's per-run
// `sweepRun(runId, () => ...)`) runs under the same lock, so its callback is a
// transaction scope too. Inside any such body we MUST NOT `await` (blocks the
// lock), serialize or parse JSON (allocates on the hot path under the lock),
// reach the network (`fetch`), or run a TypeBox `Value.Check`/`Value.Compile` —
// the caller pre-serializes and validates before the transaction opens.
//
// This is an AST scan (not a regex over source text): it walks the callback body
// AND, to full transitive depth, the bodies of any function the callback calls —
// both same-file helpers AND functions imported over a RELATIVE import (the
// `*-queries.ts` modules a `writeTxn` body routes its inserts through). So
// routing a `JSON.stringify` through a chain of private helpers, or through a
// cross-file query function, no longer escapes the rule the way the old
// same-file-only inliner let it.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  callbackBodiesOf,
  collectAwaits,
  collectCalls,
  lineOf,
  parseSource,
  resolveImportedFunctionBody,
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

/** A `SAVEPOINT …` opener: a call whose first argument is a string literal
 * beginning with `SAVEPOINT` (e.g. `db.exec("SAVEPOINT sweep_run")`). */
function isSavepointOpener(node: ts.CallExpression): boolean {
  const arg = node.arguments[0];
  return arg !== undefined && ts.isStringLiteral(arg) && arg.text.startsWith("SAVEPOINT");
}

/** Names of same-file functions whose body opens a `SAVEPOINT` — their
 * callback arguments run under the write lock (the sweep's `sweepRun`). */
function savepointWrapperNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const [name, body] of sameFileFunctionBodies(sf)) {
    for (const call of collectCalls(body, sf, false)) {
      if (isSavepointOpener(call.node)) {
        names.add(name);
        break;
      }
    }
  }
  return names;
}

/** Bodies of function-expression arguments passed (in ANY position) to a call of
 * one of `names` — `sweepRun(runId, () => { ... })` hands its closure as the
 * SECOND argument, which `callbackBodiesOf` (first-arg only) would miss. */
function savepointCallbackBodies(sf: ts.SourceFile, names: Set<string>): ts.Node[] {
  const out: ts.Node[] = [];
  if (names.size === 0) return out;
  for (const call of collectCalls(sf, sf)) {
    if (!names.has(call.name)) continue;
    for (const arg of call.node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) out.push(arg.body);
    }
  }
  return out;
}

/** Every transaction scope in the file: `writeTxn`/`transaction` callbacks plus
 * `SAVEPOINT`-wrapper callbacks. */
function collectTxnScopeBodies(sf: ts.SourceFile): ts.Node[] {
  return [...callbackBodiesOf(sf, TXN_CALLEES), ...savepointCallbackBodies(sf, savepointWrapperNames(sf))];
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

interface Frame {
  body: ts.Node;
  sf: ts.SourceFile;
  file: string;
}

/** Scan a transaction scope and every function it reaches, to full transitive
 * depth. A synchronously-called function runs under the same write lock, so its
 * body is scanned too — whether it is a same-file helper OR a function imported
 * over a relative import (the `*-queries.ts` modules). A `seen` set keyed by
 * `file::name` makes the cross-file walk cycle-safe; `sameFileFunctionBodies` is
 * memoised per module. */
function scanScope(rootBody: ts.Node, rootSf: ts.SourceFile, rootFile: string): Offender[] {
  const offenders: Offender[] = [];
  const seen = new Set<string>();
  const helpersCache = new Map<string, Map<string, ts.Node>>();
  const helpersFor = (file: string, sf: ts.SourceFile): Map<string, ts.Node> => {
    let h = helpersCache.get(file);
    if (h === undefined) {
      h = sameFileFunctionBodies(sf);
      helpersCache.set(file, h);
    }
    return h;
  };
  const stack: Frame[] = [{ body: rootBody, sf: rootSf, file: rootFile }];
  while (stack.length > 0) {
    const { body, sf, file } = stack.pop()!;
    offenders.push(...scanBody(body, sf, file));
    const dir = dirname(file);
    const helpers = helpersFor(file, sf);
    for (const call of collectCalls(body, sf, true)) {
      const sameKey = `${file}::${call.name}`;
      const helperBody = helpers.get(call.name);
      if (helperBody !== undefined && !seen.has(sameKey)) {
        seen.add(sameKey);
        stack.push({ body: helperBody, sf, file });
        continue;
      }
      const imported = resolveImportedFunctionBody(sf, dir, call.name);
      if (imported !== undefined) {
        const crossKey = `${imported.sf.fileName}::${call.name}`;
        if (!seen.has(crossKey)) {
          seen.add(crossKey);
          stack.push({ body: imported.body, sf: imported.sf, file: imported.sf.fileName });
        }
      }
    }
  }
  return offenders;
}

function scanFile(file: string): Offender[] {
  const sf = parseSource(file);
  const offenders: Offender[] = [];
  for (const body of collectTxnScopeBodies(sf)) offenders.push(...scanScope(body, sf, file));
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
    const out: Offender[] = [];
    for (const body of collectTxnScopeBodies(sf)) out.push(...scanScope(body, sf, "synthetic.ts"));
    return out;
  };

  test("catches await / fetch / JSON.parse directly in a txn callback", () => {
    const src = `this.writeTxn(() => { const x = JSON.parse(s); fetch(u); });`;
    const kinds = scanSynthetic(src).map((o) => o.kind);
    expect(kinds).toContain("JSON.parse");
    expect(kinds).toContain("fetch");
  });

  test("catches JSON.stringify reached through a cross-file queries function", () => {
    const caller = join(__dirname, "fixtures", "txn-crossfile", "caller.ts");
    expect(scanFile(caller).map((o) => o.kind)).toContain("JSON.stringify");
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

  test("catches JSON.stringify reached through two levels of same-file helpers", () => {
    // `a` calls `b`; full-depth following scans `b` even though the txn calls `a`.
    const src = `
      function b() { return JSON.stringify(z); }
      function a() { return b(); }
      this.writeTxn(() => { a(); });
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toContain("JSON.stringify");
  });

  test("catches JSON.stringify inside a sweepRun SAVEPOINT closure", () => {
    const src = `
      const sweepRun = (id, mutate) => { db.exec("SAVEPOINT sweep_run"); mutate(); db.exec("RELEASE sweep_run"); };
      sweepRun("r", () => { insert(JSON.stringify(p)); });
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toContain("JSON.stringify");
  });

  test("does not flag a JSON.stringify in the sweepRun wrapper's own catch (outside the savepoint)", () => {
    // The wrapper's catch runs after RELEASE/ROLLBACK — outside the lock; only
    // the callback the wrapper invokes is a transaction scope.
    const src = `
      const sweepRun = (id, mutate) => {
        db.exec("SAVEPOINT sweep_run");
        try { mutate(); db.exec("RELEASE sweep_run"); }
        catch (err) { log(JSON.stringify({ id, err })); }
      };
      sweepRun("r", () => { db.query("q").run(); });
    `;
    expect(scanSynthetic(src)).toHaveLength(0);
  });
});
