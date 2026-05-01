import { describe, expect, test } from "bun:test";
import { evaluateCondition, evaluateConditionSource, parseCondition, resolvePath } from "../../src/engine/condition.ts";
import { ConditionParseError } from "../../src/types/condition.ts";

describe("parseCondition", () => {
  test("simple equality", () => {
    const ast = parseCondition("outcome=success");
    expect(ast).toEqual({ kind: "cmp", path: ["outcome"], op: "=", value: "success" });
  });

  test("inequality", () => {
    const ast = parseCondition("outcome!=fail");
    expect(ast.kind).toBe("cmp");
    if (ast.kind === "cmp") expect(ast.op).toBe("!=");
  });

  test("conjunction", () => {
    const ast = parseCondition("outcome=success && context.ok=true");
    expect(ast.kind).toBe("and");
  });

  test("quoted string value", () => {
    const ast = parseCondition(`context.msg="hello world"`);
    if (ast.kind !== "cmp") throw new Error("expected cmp");
    expect(ast.value).toBe("hello world");
  });

  test("numeric value", () => {
    const ast = parseCondition("context.count=42");
    if (ast.kind !== "cmp") throw new Error("expected cmp");
    expect(ast.value).toBe(42);
  });

  test("negative number", () => {
    const ast = parseCondition("context.delta=-3.5");
    if (ast.kind !== "cmp") throw new Error("expected cmp");
    expect(ast.value).toBe(-3.5);
  });

  test("boolean literals", () => {
    const ast = parseCondition("context.ok=true && context.done!=false");
    expect(ast.kind).toBe("and");
  });

  test("null literal", () => {
    const ast = parseCondition("context.maybe=null");
    if (ast.kind !== "cmp") throw new Error("expected cmp");
    expect(ast.value).toBeNull();
  });

  test("path with dots", () => {
    const ast = parseCondition("context.graph.goal=ship");
    if (ast.kind !== "cmp") throw new Error("expected cmp");
    expect(ast.path).toEqual(["context", "graph", "goal"]);
  });

  test("trailing garbage throws", () => {
    expect(() => parseCondition("outcome=success garbage")).toThrow(ConditionParseError);
  });

  test("bare key without operator → truthy clause (attractor §10.5)", () => {
    const ast = parseCondition("context.flag");
    expect(ast.kind).toBe("truthy");
    if (ast.kind === "truthy") expect(ast.path).toEqual(["context", "flag"]);
  });

  test("missing value throws", () => {
    expect(() => parseCondition("outcome=")).toThrow(ConditionParseError);
  });
});

describe("resolvePath", () => {
  const env = {
    outcome: "success",
    context: {
      ok: true,
      count: 5,
      "graph.goal": "deploy",
      nested: "value",
    },
  };

  test("outcome resolves to status", () => {
    expect(resolvePath(["outcome"], env)).toBe("success");
  });

  test("outcome sub-path returns undefined", () => {
    expect(resolvePath(["outcome", "something"], env)).toBeUndefined();
  });

  test("context.key reads from map", () => {
    expect(resolvePath(["context", "ok"], env)).toBe(true);
    expect(resolvePath(["context", "count"], env)).toBe(5);
  });

  test("context.dotted.key reads with dots joined", () => {
    expect(resolvePath(["context", "graph", "goal"], env)).toBe("deploy");
  });

  test("missing key returns undefined", () => {
    expect(resolvePath(["context", "missing"], env)).toBeUndefined();
  });

  test("unknown top-level namespace returns undefined", () => {
    expect(resolvePath(["foo", "bar"], env)).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  const env = {
    outcome: "success",
    context: {
      tests_passed: true,
      errors: 0,
      msg: "hello",
      "graph.goal": "deploy",
    },
  };

  test("basic equality true", () => {
    expect(evaluateCondition(parseCondition("outcome=success"), env)).toBe(true);
  });

  test("basic equality false", () => {
    expect(evaluateCondition(parseCondition("outcome=fail"), env)).toBe(false);
  });

  test("inequality", () => {
    expect(evaluateCondition(parseCondition("outcome!=fail"), env)).toBe(true);
  });

  test("conjunction both true", () => {
    expect(evaluateCondition(parseCondition("outcome=success && context.tests_passed=true"), env)).toBe(true);
  });

  test("conjunction with false right", () => {
    expect(evaluateCondition(parseCondition("outcome=success && context.errors=1"), env)).toBe(false);
  });

  test("boolean coercion: context.ok=true matches true", () => {
    expect(evaluateCondition(parseCondition("context.tests_passed=true"), env)).toBe(true);
  });

  test("number equality", () => {
    expect(evaluateCondition(parseCondition("context.errors=0"), env)).toBe(true);
  });

  test("string <-> number coercion", () => {
    const env2 = { outcome: "ok", context: { count: "5" } };
    expect(evaluateCondition(parseCondition("context.count=5"), env2)).toBe(true);
  });

  test("missing key compares as empty string (attractor §10.4)", () => {
    // Per spec: missing context keys evaluate as empty string in `=` checks.
    expect(evaluateCondition(parseCondition(`context.missing=""`), env)).toBe(true);
    expect(evaluateCondition(parseCondition(`context.missing="foo"`), env)).toBe(false);
    expect(evaluateCondition(parseCondition(`context.missing!="foo"`), env)).toBe(true);
    // null is no longer special — empty string ≠ null.
    expect(evaluateCondition(parseCondition("context.missing=null"), env)).toBe(false);
  });

  test("preferred_label as recognised top-level key (attractor §10.4)", () => {
    const env2 = {
      outcome: "success",
      context: {} as Record<string, never>,
      preferred_label: "approved",
    };
    expect(evaluateCondition(parseCondition("preferred_label=approved"), env2)).toBe(true);
    expect(evaluateCondition(parseCondition("preferred_label=rejected"), env2)).toBe(false);
  });

  test("preferred_label defaults to empty string when env omits it", () => {
    const env2 = { outcome: "success", context: {} as Record<string, never> };
    expect(evaluateCondition(parseCondition(`preferred_label=""`), env2)).toBe(true);
  });

  test("bare-key truthiness — unqualified key reads from context (§10.5)", () => {
    const env2 = {
      outcome: "ok",
      context: { feature_flag: true, empty_flag: "", missing_flag: undefined as never },
    };
    expect(evaluateCondition(parseCondition("feature_flag"), env2)).toBe(true);
    expect(evaluateCondition(parseCondition("empty_flag"), env2)).toBe(false);
    expect(evaluateCondition(parseCondition("missing_flag"), env2)).toBe(false);
  });

  test("bare-key truthiness — context.<path> form also accepted", () => {
    const env2 = {
      outcome: "ok",
      context: { ready: 1, not_ready: 0 },
    };
    expect(evaluateCondition(parseCondition("context.ready"), env2)).toBe(true);
    expect(evaluateCondition(parseCondition("context.not_ready"), env2)).toBe(false);
  });

  test("quoted value compare", () => {
    expect(evaluateCondition(parseCondition(`context.msg="hello"`), env)).toBe(true);
    expect(evaluateCondition(parseCondition(`context.msg="hi"`), env)).toBe(false);
  });
});

describe("evaluateConditionSource", () => {
  test("empty string is vacuously true", () => {
    expect(evaluateConditionSource("", { outcome: "x", context: {} })).toBe(true);
  });

  test("whitespace-only is true", () => {
    expect(evaluateConditionSource("   ", { outcome: "x", context: {} })).toBe(true);
  });

  test("actual expression evaluated", () => {
    expect(evaluateConditionSource("outcome=ok", { outcome: "ok", context: {} })).toBe(true);
  });
});
