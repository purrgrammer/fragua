import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { callbackBodiesOf, collectCalls, collectImports, DYNAMIC_SPECIFIER, propertyChain } from "../src/ts-scan.ts";

const parse = (src: string): ts.SourceFile =>
  ts.createSourceFile("s.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

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
});
