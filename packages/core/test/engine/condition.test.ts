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

// ---------------------------------------------------------------------------
// Extended operator tests
// ---------------------------------------------------------------------------

describe("parseCondition — extended operators", () => {
  test("disjunction parses as or node", () => {
    const ast = parseCondition("a=1 || b=2");
    expect(ast.kind).toBe("or");
    if (ast.kind !== "or") throw new Error("expected or");
    expect(ast.left.kind).toBe("cmp");
    expect(ast.right.kind).toBe("cmp");
  });

  test("mixed && and || — && binds tighter (a=1 && b=2 || c=3) → (and) or c=3", () => {
    const ast = parseCondition("a=1 && b=2 || c=3");
    expect(ast.kind).toBe("or");
    if (ast.kind !== "or") throw new Error("expected or");
    expect(ast.left.kind).toBe("and");
    expect(ast.right.kind).toBe("cmp");
    if (ast.right.kind === "cmp") {
      expect(ast.right.path).toEqual(["c"]);
      expect(ast.right.value).toBe(3);
    }
    if (ast.left.kind === "and") {
      expect(ast.left.left.kind).toBe("cmp");
      expect(ast.left.right.kind).toBe("cmp");
    }
  });

  test("negation parses as not node wrapping term", () => {
    const ast = parseCondition("!context.locked");
    expect(ast.kind).toBe("not");
    if (ast.kind !== "not") throw new Error("expected not");
    expect(ast.expr.kind).toBe("truthy");
    if (ast.expr.kind === "truthy") {
      expect(ast.expr.path).toEqual(["context", "locked"]);
    }
  });

  test("negation binds tighter than &&", () => {
    const ast = parseCondition("!a && b");
    expect(ast.kind).toBe("and");
    if (ast.kind !== "and") throw new Error("expected and");
    expect(ast.left.kind).toBe("not");
    expect(ast.right.kind).toBe("truthy");
  });

  test("numeric comparison operators <,>,<=,>=", () => {
    const lt = parseCondition("context.score < 5");
    const gt = parseCondition("context.score > 5");
    const lte = parseCondition("context.score <= 5");
    const gte = parseCondition("context.score >= 5");
    expect(lt.kind).toBe("cmp");
    expect(gt.kind).toBe("cmp");
    expect(lte.kind).toBe("cmp");
    expect(gte.kind).toBe("cmp");
    if (lt.kind === "cmp") expect(lt.op).toBe("<");
    if (gt.kind === "cmp") expect(gt.op).toBe(">");
    if (lte.kind === "cmp") expect(lte.op).toBe("<=");
    if (gte.kind === "cmp") expect(gte.op).toBe(">=");
  });

  test("contains operator parses", () => {
    const ast = parseCondition(`context.path contains "src/"`);
    expect(ast.kind).toBe("contains");
    if (ast.kind !== "contains") throw new Error("expected contains");
    expect(ast.path).toEqual(["context", "path"]);
    expect(ast.value).toBe("src/");
  });

  test("matches operator parses regex literal", () => {
    const ast = parseCondition("context.area matches /^auth/");
    expect(ast.kind).toBe("matches");
    if (ast.kind !== "matches") throw new Error("expected matches");
    expect(ast.path).toEqual(["context", "area"]);
    expect(ast.pattern).toBe("^auth");
    expect(ast.flags).toBe("");
  });

  test("matches operator parses regex with flags", () => {
    const ast = parseCondition("context.area matches /foo/i");
    expect(ast.kind).toBe("matches");
    if (ast.kind !== "matches") throw new Error("expected matches");
    expect(ast.pattern).toBe("foo");
    expect(ast.flags).toBe("i");
  });

  test("malformed regex (no closing slash) throws ConditionParseError", () => {
    expect(() => parseCondition("context.area matches /^auth")).toThrow(ConditionParseError);
  });

  test("unbalanced parenthesis throws ConditionParseError", () => {
    expect(() => parseCondition("(a=1 && b=2")).toThrow(ConditionParseError);
  });

  test("parenthesised grouping overrides precedence", () => {
    // a=1 && (b=2 || c=3) — root is 'and', right child is 'or'
    const ast = parseCondition("a=1 && (b=2 || c=3)");
    expect(ast.kind).toBe("and");
    if (ast.kind !== "and") throw new Error("expected and");
    expect(ast.right.kind).toBe("or");
  });
});

describe("evaluateCondition — extended operators", () => {
  test("disjunction true when either side true", () => {
    const env = { outcome: "ok", context: { a: 99, b: 2 } };
    expect(evaluateCondition(parseCondition("a=1 || b=2"), env)).toBe(true);
    expect(evaluateCondition(parseCondition("a=1 || b=99"), env)).toBe(false);
  });

  test("negation flips truthy clause", () => {
    const envLocked = { outcome: "ok", context: { locked: true } };
    const envUnlocked = { outcome: "ok", context: { locked: false } };
    expect(evaluateCondition(parseCondition("!context.locked"), envLocked)).toBe(false);
    expect(evaluateCondition(parseCondition("!context.locked"), envUnlocked)).toBe(true);
  });

  test("numeric > with number", () => {
    const env = { outcome: "ok", context: { score: 10 } };
    expect(evaluateCondition(parseCondition("context.score > 5"), env)).toBe(true);
    const envLow = { outcome: "ok", context: { score: 3 } };
    expect(evaluateCondition(parseCondition("context.score > 5"), envLow)).toBe(false);
  });

  test("numeric comparisons coerce string lhs to number", () => {
    const env = { outcome: "ok", context: { score: "10" } };
    expect(evaluateCondition(parseCondition("context.score > 5"), env)).toBe(true);
    expect(evaluateCondition(parseCondition("context.score < 5"), env)).toBe(false);
  });

  test("comparison falls back to lexicographic for non-numeric strings", () => {
    const env = { outcome: "ok", context: { name: "beta" } };
    expect(evaluateCondition(parseCondition(`context.name > "alpha"`), env)).toBe(true);
    expect(evaluateCondition(parseCondition(`context.name < "alpha"`), env)).toBe(false);
  });

  test("contains — substring on string lhs", () => {
    const env = { outcome: "ok", context: { path: "packages/src/foo" } };
    expect(evaluateCondition(parseCondition(`context.path contains "src/"`), env)).toBe(true);
    expect(evaluateCondition(parseCondition(`context.path contains "dist/"`), env)).toBe(false);
  });

  test("contains — membership on array lhs", () => {
    const env = { outcome: "ok", context: { tags: ["a", "b"] as unknown as string } };
    expect(evaluateCondition(parseCondition(`context.tags contains "a"`), env)).toBe(true);
    expect(evaluateCondition(parseCondition(`context.tags contains "c"`), env)).toBe(false);
  });

  test("matches — regex applied to string lhs", () => {
    const env = { outcome: "ok", context: { area: "auth.login" } };
    expect(evaluateCondition(parseCondition("context.area matches /^auth/"), env)).toBe(true);
    const envBilling = { outcome: "ok", context: { area: "billing" } };
    expect(evaluateCondition(parseCondition("context.area matches /^auth/"), envBilling)).toBe(false);
  });

  test("matches — flags honoured (case-insensitive)", () => {
    const env = { outcome: "ok", context: { area: "auth.login" } };
    expect(evaluateCondition(parseCondition("context.area matches /^AUTH/i"), env)).toBe(true);
  });

  test("matches — missing key (undefined) → false, not throw", () => {
    const env = { outcome: "ok", context: {} };
    expect(evaluateCondition(parseCondition("context.area matches /^auth/"), env)).toBe(false);
  });

  test("mixed precedence end-to-end: a=1 && b=2 || c=3 with only c=3 true → true", () => {
    const env = { outcome: "ok", context: { a: 99, b: 99, c: 3 } };
    expect(evaluateCondition(parseCondition("a=1 && b=2 || c=3"), env)).toBe(true);
  });
});
