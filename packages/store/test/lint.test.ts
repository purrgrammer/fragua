// Structural lint — ARCHITECTURE.md §5, invariant I1.
//
// Every store write runs inside a `this.writeTxn(() => ...)` (or a raw
// `db.transaction(() => ...)`) callback whose body executes under the SQLite
// write lock. A closure handed to a same-file `SAVEPOINT` wrapper (e.g.
// `wrap(id, () => ...)`) runs under the same lock, so its callback is a
// transaction scope too. Inside any such body we MUST NOT `await` (blocks the
// lock), serialize or parse JSON (allocates on the hot path under the lock),
// reach the network (`fetch`), or run a TypeBox `Value.Check`/`Value.Compile` —
// the caller pre-serializes and validates before the transaction opens.
//
// A callback passed by name (`const body = () => {…}; writeTxn(body)`) is
// resolved through its enclosing `const` / function declaration and scanned the
// same as an inline one; a callback that can't be resolved statically fails the
// lint as an unresolved txn callback (the one exemption is a function itself
// named `writeTxn` forwarding its own parameter — its callers are scanned).
//
// This is an AST scan (not a regex over source text): it walks the callback body
// AND, to full transitive depth, the bodies of any function the callback calls —
// both same-file helpers AND functions imported over a RELATIVE import (the
// `*-queries.ts` modules a `writeTxn` body routes its inserts through). So
// routing a `JSON.stringify` through a chain of private helpers, or through a
// cross-file query function, no longer escapes the rule the way the old
// same-file-only inliner let it.
//
// The store sub-interface modules reach the façade through a `StoreCtx`
// parameter, so a call like `ctx.validatePayload(p)` resolves to neither a
// same-file helper nor a named import. Calls on a `StoreCtx`-typed binding are
// therefore handled explicitly: `ctx.validatePayload` inside a txn body is
// flagged outright (it serializes), and `ctx.<m>` / `ctx.store.<m>` /
// `ctx.blobs.<m>` / `ctx.metrics.<m>` are followed into the implementing
// class method (`SqliteStore` / `BlobFS` / `Metrics`). `ctx.db.*` (bun:sqlite)
// and the injected `ctx.now` clock have no in-repo body and are not followed.
//
// Callee text is normalised through literal-key element access, so
// `JSON["stringify"](x)` / ``ctx[`validatePayload`]()`` match like their dotted
// forms. A computed member access on `JSON`, `Value`, or a `StoreCtx` binding
// (or its `store` / `blobs` / `metrics` member) inside a txn scope can't be
// resolved statically, so it is reported as an offender in its own right.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CallbackScope,
  type CallInfo,
  callbackBodiesOf,
  classMethodBodies,
  collectAwaits,
  collectCalls,
  lineOf,
  literalKey,
  parseSource,
  propertyChain,
  resolveImportedFunctionBody,
  sameFileFunctionBodies,
  typedBindings,
  walk,
} from "@fragua/test-utils";
import ts from "typescript";

const STORE_SRC = join(__dirname, "..", "src");
const ROOTS = [STORE_SRC, join(__dirname, "..", "..", "daemon", "src")];

const CTX_TYPE = "StoreCtx";

/** `StoreCtx` methods that serialize and so must run before the txn opens. */
const BANNED_CTX_METHODS = new Set(["validatePayload"]);

interface ClassImpl {
  file: string;
  className: string;
}

const SQLITE_STORE: ClassImpl = { file: join(STORE_SRC, "store.ts"), className: "SqliteStore" };

/** `StoreCtx` member ("" = a method on the ctx itself) → the class whose method
 * bodies implement it. `db` and `now` are deliberately absent. */
const CTX_MEMBER_IMPLS: Record<string, ClassImpl> = {
  "": SQLITE_STORE,
  store: SQLITE_STORE,
  blobs: { file: join(STORE_SRC, "blob-fs.ts"), className: "BlobFS" },
  metrics: { file: join(STORE_SRC, "metrics.ts"), className: "Metrics" },
};

const TXN_CALLEES = ["writeTxn", "transaction"];

/** Callee text that must never appear in a transaction body. `fetch` is matched
 * by its identifier name separately. */
const BANNED_CALL_TEXT = new Set(["JSON.stringify", "JSON.parse", "Value.Check", "Value.Compile"]);

/** Globals whose banned members a computed key could reach unseen. */
const GUARDED_GLOBALS = new Set(["JSON", "Value"]);

/** `StoreCtx` members whose methods are followed — a computed key on them hides
 * which method runs. */
const GUARDED_CTX_MEMBERS = new Set(["store", "blobs", "metrics"]);

const COMPUTED_ACCESS = "computed member access on";

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
 * callback arguments run under the write lock. */
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
function collectTxnScopeBodies(sf: ts.SourceFile): CallbackScope[] {
  const savepoints = savepointCallbackBodies(sf, savepointWrapperNames(sf)).map((body) => ({
    body,
    unresolved: false,
  }));
  return [...callbackBodiesOf(sf, TXN_CALLEES), ...savepoints];
}

/** A call on a `StoreCtx` binding: `ctx.m()` → `{ member: "", method: "m" }`,
 * `ctx.blobs.put()` → `{ member: "blobs", method: "put" }`. */
function ctxCall(call: CallInfo, ctxNames: Set<string>): { member: string; method: string } | undefined {
  const chain = propertyChain(call.node.expression);
  if (chain === undefined || !ctxNames.has(chain[0] ?? "")) return undefined;
  if (chain.length === 2) return { member: "", method: chain[1]! };
  if (chain.length === 3) return { member: chain[1]!, method: chain[2]! };
  return undefined;
}

/** The guarded object a computed (non-literal-key) element access hangs off:
 * `JSON` / `Value`, a `StoreCtx` binding, or `<ctx>.store|blobs|metrics`. */
function guardedComputedObject(node: ts.ElementAccessExpression, ctxNames: Set<string>): string | undefined {
  if (literalKey(node) !== undefined) return undefined;
  const chain = propertyChain(node.expression);
  const head = chain?.[0];
  if (chain === undefined || head === undefined) return undefined;
  if (chain.length === 1 && (GUARDED_GLOBALS.has(head) || ctxNames.has(head))) return head;
  const member = chain[1];
  if (chain.length === 2 && ctxNames.has(head) && member !== undefined && GUARDED_CTX_MEMBERS.has(member))
    return chain.join(".");
  return undefined;
}

/** Scan one node (a transaction body or an inlined helper body) for the banned
 * constructs, excluding nested deferred functions. */
function scanBody(body: ts.Node, sf: ts.SourceFile, file: string, ctxNames: Set<string>): Offender[] {
  const offenders: Offender[] = [];
  for (const a of collectAwaits(body)) offenders.push({ file, kind: "await", line: lineOf(sf, a) });
  walk(
    body,
    (n) => {
      if (!ts.isElementAccessExpression(n)) return;
      const obj = guardedComputedObject(n, ctxNames);
      if (obj !== undefined) offenders.push({ file, kind: `${COMPUTED_ACCESS} ${obj}`, line: lineOf(sf, n) });
    },
    true,
  );
  for (const call of collectCalls(body, sf, true)) {
    const onCtx = ctxCall(call, ctxNames);
    if (call.name === "fetch") offenders.push({ file, kind: "fetch", line: lineOf(sf, call.node) });
    else if (BANNED_CALL_TEXT.has(call.text)) offenders.push({ file, kind: call.text, line: lineOf(sf, call.node) });
    else if (onCtx?.member === "" && BANNED_CTX_METHODS.has(onCtx.method))
      offenders.push({ file, kind: call.text, line: lineOf(sf, call.node) });
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
  const ctxNamesCache = new Map<string, Set<string>>();
  const ctxNamesFor = (file: string, sf: ts.SourceFile): Set<string> => {
    let names = ctxNamesCache.get(file);
    if (names === undefined) {
      names = typedBindings(sf, CTX_TYPE);
      ctxNamesCache.set(file, names);
    }
    return names;
  };
  const implCache = new Map<string, { sf: ts.SourceFile; methods: Map<string, ts.Node> }>();
  const implFor = (impl: ClassImpl): { sf: ts.SourceFile; methods: Map<string, ts.Node> } => {
    const key = `${impl.file}::${impl.className}`;
    let entry = implCache.get(key);
    if (entry === undefined) {
      const sf = parseSource(impl.file);
      entry = { sf, methods: classMethodBodies(sf, impl.className) };
      implCache.set(key, entry);
    }
    return entry;
  };
  const stack: Frame[] = [{ body: rootBody, sf: rootSf, file: rootFile }];
  while (stack.length > 0) {
    const { body, sf, file } = stack.pop()!;
    const ctxNames = ctxNamesFor(file, sf);
    offenders.push(...scanBody(body, sf, file, ctxNames));
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
        continue;
      }
      const onCtx = ctxCall(call, ctxNames);
      const impl = onCtx === undefined ? undefined : CTX_MEMBER_IMPLS[onCtx.member];
      if (onCtx === undefined || impl === undefined) continue;
      const { sf: implSf, methods } = implFor(impl);
      const methodBody = methods.get(onCtx.method);
      const implKey = `${impl.file}::${impl.className}.${onCtx.method}`;
      if (methodBody !== undefined && !seen.has(implKey)) {
        seen.add(implKey);
        stack.push({ body: methodBody, sf: implSf, file: impl.file });
      }
    }
  }
  return offenders;
}

const UNRESOLVED_CALLBACK = "unresolved txn callback";

/** Every offender in the file's transaction scopes. A txn call whose callback
 * can't be resolved statically is reported, not scanned. */
function scanSf(sf: ts.SourceFile, file: string): Offender[] {
  const offenders: Offender[] = [];
  for (const { body, unresolved } of collectTxnScopeBodies(sf)) {
    if (unresolved) offenders.push({ file, kind: UNRESOLVED_CALLBACK, line: lineOf(sf, body) });
    else offenders.push(...scanScope(body, sf, file));
  }
  return offenders;
}

function scanFile(file: string): Offender[] {
  return scanSf(parseSource(file), file);
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
    return scanSf(sf, "synthetic.ts");
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

  test("catches ctx.validatePayload called inside a txn body", () => {
    const caller = join(__dirname, "fixtures", "txn-ctx", "caller.ts");
    const kinds = scanFile(caller).map((o) => o.kind);
    expect(kinds).toContain("ctx.validatePayload");
    expect(kinds).toContain("JSON.stringify");
  });

  test("follows ctx.blobs / ctx.metrics into their implementations without false positives", () => {
    const src = `
      function f(ctx: StoreCtx) {
        ctx.writeTxn(() => { ctx.blobs.put(s, b); ctx.metrics.recordOccConflict(); ctx.now(); ctx.db.exec("x"); });
      }
    `;
    expect(scanSynthetic(src)).toHaveLength(0);
  });

  test("does not flag ctx.validatePayload outside the txn body", () => {
    const src = `
      function f(ctx: StoreCtx) {
        const p = ctx.validatePayload(x);
        ctx.writeTxn(() => { insert(p); });
      }
    `;
    expect(scanSynthetic(src)).toHaveLength(0);
  });

  test("catches JSON.stringify in a txn callback passed by const name", () => {
    const caller = join(__dirname, "fixtures", "txn-named-callback", "caller.ts");
    expect(scanFile(caller).map((o) => o.kind)).toContain("JSON.stringify");
  });

  test("catches JSON.parse in a txn callback passed by function-declaration name", () => {
    const src = `
      function body() { JSON.parse(s); }
      db.transaction(body);
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toContain("JSON.parse");
  });

  test("flags a txn callback that cannot be resolved", () => {
    const caller = join(__dirname, "fixtures", "txn-named-callback", "unresolved.ts");
    expect(scanFile(caller).map((o) => o.kind)).toContain(UNRESOLVED_CALLBACK);
  });

  test("does not flag a txn-named forwarder passing its own parameter", () => {
    const src = `const ctx = { writeTxn: (fn) => this.writeTxn(fn) };`;
    expect(scanSynthetic(src)).toHaveLength(0);
  });

  test("flags a parameter forwarded by a non-txn wrapper", () => {
    const src = `function run(cb) { db.transaction(cb); }`;
    expect(scanSynthetic(src).map((o) => o.kind)).toEqual([UNRESOLVED_CALLBACK]);
  });

  test("flags an unresolved txn call that is an arrow's expression body", () => {
    expect(scanSynthetic(`const run = (p) => db.transaction(makeBody(p));`).map((o) => o.kind)).toEqual([
      UNRESOLVED_CALLBACK,
    ]);
    expect(scanSynthetic(`const run = (cb) => ctx.writeTxn(cb);`).map((o) => o.kind)).toEqual([UNRESOLVED_CALLBACK]);
  });

  test("does not resolve a named callback past an inner same-named binding", () => {
    const src = `
      function body() { JSON.parse(s); }
      function f() { const body = make(); db.transaction(body); }
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toEqual([UNRESOLVED_CALLBACK]);
  });

  test('catches JSON["stringify"] inside a txn callback (R2-M1)', () => {
    const caller = join(__dirname, "fixtures", "txn-element-access", "json-bracket.ts");
    expect(scanFile(caller).map((o) => o.kind)).toContain("JSON.stringify");
  });

  test("catches template-literal and ctx element-access callees", () => {
    const src = `
      function f(ctx: StoreCtx) {
        ctx.writeTxn(() => { JSON[\`parse\`](s); ctx["validatePayload"](p); });
      }
    `;
    const kinds = scanSynthetic(src).map((o) => o.kind);
    expect(kinds).toContain("JSON.parse");
    expect(kinds).toContain("ctx.validatePayload");
  });

  test("flags a computed member access on JSON / Value / ctx inside a txn body", () => {
    const src = `
      function f(ctx: StoreCtx, k: string) {
        ctx.writeTxn(() => { JSON[k](x); Value[k](s, v); ctx[k](); ctx.blobs[k](b); });
      }
    `;
    expect(scanSynthetic(src).map((o) => o.kind)).toEqual([
      `${COMPUTED_ACCESS} JSON`,
      `${COMPUTED_ACCESS} Value`,
      `${COMPUTED_ACCESS} ctx`,
      `${COMPUTED_ACCESS} ctx.blobs`,
    ]);
  });

  test("does not flag computed access outside the txn or in a nested deferred callback", () => {
    const src = `
      function f(ctx: StoreCtx, k: string) {
        const s = JSON[k](x);
        ctx.writeTxn(() => { on("x", () => JSON[k](y)); insert(s); });
      }
    `;
    expect(scanSynthetic(src)).toHaveLength(0);
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
