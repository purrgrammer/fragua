import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  callbackBodiesOf,
  collectCalls,
  collectImports,
  DYNAMIC_SPECIFIER,
  type NormalizedCallee,
  normalizeCallee,
  propertyChain,
} from "../src/ts-scan.ts";

const parse = (src: string): ts.SourceFile =>
  ts.createSourceFile("s.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** `normalizeCallee` of the callee of every call in `src`, in source order. */
const calleesOf = (src: string): Array<NormalizedCallee | undefined> => {
  const sf = parse(src);
  return collectCalls(sf, sf).map((c) => normalizeCallee(c.node.expression));
};

const chainsOf = (src: string): Array<string[] | undefined> => calleesOf(src).map((c) => c?.chain);

describe("ts-scan", () => {
  test("collectImports records a no-substitution template specifier verbatim and a computed one as <dynamic>", () => {
    const imports = collectImports(
      parse("const a = import(`node:fs`);\nconst b = import(s);\nconst c = require(s);\n"),
    );
    expect(imports.map((i) => [i.kind, i.module])).toEqual([
      ["dynamic", "node:fs"],
      ["dynamic", DYNAMIC_SPECIFIER],
      ["require", DYNAMIC_SPECIFIER],
    ]);
  });

  test("callbackBodiesOf resolves a named callback and returns the call node when unresolvable", () => {
    const resolved = callbackBodiesOf(parse("const body = () => { JSON.stringify(x); };\nwriteTxn(body);\n"), [
      "writeTxn",
    ]);
    expect(resolved.map((s) => s.unresolved)).toEqual([false]);
    expect(resolved[0] !== undefined && ts.isArrowFunction(resolved[0].body.parent)).toBe(true);

    const unresolved = callbackBodiesOf(parse("const run = (p) => writeTxn(f(p));\n"), ["writeTxn"]);
    expect(unresolved.map((s) => s.unresolved)).toEqual([true]);
    expect(unresolved[0] !== undefined && ts.isCallExpression(unresolved[0].body)).toBe(true);
    expect(unresolved[0]?.body.getText()).toBe("writeTxn(f(p))");
  });

  test("collectCalls normalises a literal element-access callee to its dotted name", () => {
    const sf = parse('JSON["stringify"](x);\nJSON[`parse`](y);\n');
    expect(collectCalls(sf, sf).map((c) => [c.name, c.text])).toEqual([
      ["stringify", "JSON.stringify"],
      ["parse", "JSON.parse"],
    ]);
  });

  test("propertyChain resolves literal element keys and rejects computed ones", () => {
    const exprOf = (src: string): ts.Expression => {
      const stmt = parse(src).statements[0];
      if (stmt === undefined || !ts.isExpressionStatement(stmt)) throw new Error("expected an expression statement");
      return stmt.expression;
    };
    expect(propertyChain(exprOf('ctx["blobs"].put;'))).toEqual(["ctx", "blobs", "put"]);
    expect(propertyChain(exprOf("JSON[k];"))).toBeUndefined();
  });

  test("normalizeCallee strips globalThis / global / self / window receiver chains", () => {
    expect(
      chainsOf(
        "globalThis.JSON.stringify(a);\nglobal.JSON.parse(b);\nself.fetch(c);\nwindow.globalThis.Bun.spawn(d);\n",
      ),
    ).toEqual([["JSON", "stringify"], ["JSON", "parse"], ["fetch"], ["Bun", "spawn"]]);
  });

  test("normalizeCallee resolves literal keys through a global receiver", () => {
    expect(chainsOf('globalThis["JSON"]["stringify"](x);\n')).toEqual([["JSON", "stringify"]]);
  });

  test("normalizeCallee resolves const / let aliases, destructurings and alias chains", () => {
    const src = [
      "const r = require;",
      "let J = JSON;",
      "const { stringify } = JSON;",
      "const { parse: p } = globalThis.JSON;",
      "const a = JSON;",
      "const b = a;",
      'r("x");',
      "J.stringify(1);",
      "stringify(2);",
      "p(3);",
      "b.parse(4);",
    ].join("\n");
    expect(chainsOf(src)).toEqual([
      ["require"],
      ["JSON", "stringify"],
      ["JSON", "stringify"],
      ["JSON", "parse"],
      ["JSON", "parse"],
    ]);
  });

  test("normalizeCallee reports and drops a .call / .apply / .bind forwarder", () => {
    expect(calleesOf("JSON.stringify.call(null, x);\nJSON.parse.apply(null, [y]);\n")).toEqual([
      { chain: ["JSON", "stringify"], forwarder: "call" },
      { chain: ["JSON", "parse"], forwarder: "apply" },
    ]);
  });

  test("normalizeCallee does not strip a locally bound receiver (control)", () => {
    expect(chainsOf("const window = pick();\nwindow.fetch(u);\nconst f = (global) => global.JSON.parse(s);\n")).toEqual(
      [["pick"], ["window", "fetch"], ["global", "JSON", "parse"]],
    );
  });

  test("normalizeCallee leaves a non-chain alias opaque (control)", () => {
    expect(chainsOf('const r = makeRequire();\nr("x");\n')).toEqual([["makeRequire"], ["r"]]);
  });

  test("collectImports records aliased, global-receiver and forwarded require", () => {
    const src = [
      "function f() {",
      "  const r = require;",
      '  r("node:fs");',
      '  globalThis.require("x");',
      '  require.call(null, "y");',
      "}",
    ].join("\n");
    expect(collectImports(parse(src)).map((i) => [i.kind, i.module])).toEqual([
      ["require", "node:fs"],
      ["require", "x"],
      ["require", "y"],
    ]);
  });
});
