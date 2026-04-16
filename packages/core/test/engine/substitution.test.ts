import { describe, expect, test } from "bun:test";
import { collectReferences, type NodeOutput, substitute } from "../../src/engine/substitution.ts";

describe("substitute", () => {
  test("no tokens → template unchanged", () => {
    expect(substitute("hello world")).toBe("hello world");
  });

  test("${context.x} replaces from context", () => {
    const out = substitute("Hello, ${context.name}!", { context: { name: "Ada" } });
    expect(out).toBe("Hello, Ada!");
  });

  test("${context.graph.goal} preserves dotted key", () => {
    const out = substitute("Goal: ${context.graph.goal}", { context: { "graph.goal": "ship" } });
    expect(out).toBe("Goal: ship");
  });

  test("missing context key substitutes empty string", () => {
    expect(substitute("[${context.missing}]")).toBe("[]");
  });

  test("number context value stringified", () => {
    expect(substitute("count=${context.n}", { context: { n: 42 } })).toBe("count=42");
  });

  test("boolean context value stringified", () => {
    expect(substitute("ok=${context.ok}", { context: { ok: true } })).toBe("ok=true");
  });

  test("object context value stringified as JSON", () => {
    expect(substitute("data=${context.obj}", { context: { obj: { a: 1 } } })).toBe('data={"a":1}');
  });

  test("$nodeId.output substitutes raw output", () => {
    const outputs = new Map<string, NodeOutput>([["plan", { success: true, output: "the plan", timestamp: 0 }]]);
    expect(substitute("Plan: $plan.output", { nodeOutputs: outputs })).toBe("Plan: the plan");
  });

  test("$nodeId.output.path traverses structured data", () => {
    const outputs = new Map<string, NodeOutput>([
      ["analyze", { success: true, output: "", data: { summary: "ok", items: ["a", "b"] }, timestamp: 0 }],
    ]);
    expect(substitute("sum=$analyze.output.summary", { nodeOutputs: outputs })).toBe("sum=ok");
    expect(substitute("item=$analyze.output.items[1]", { nodeOutputs: outputs })).toBe("item=b");
  });

  test("missing node output substitutes empty", () => {
    expect(substitute("$plan.output")).toBe("");
  });

  test("positional args", () => {
    const out = substitute("$1 and $2 and $3", { args: { $1: "a", $2: "b", $3: "c" } });
    expect(out).toBe("a and b and c");
  });

  test("positional args don't match longer tokens", () => {
    // $10 is not a supported token, so no unexpected eating.
    const out = substitute("say $1 times or say $10", { args: { $1: "ONE" } });
    expect(out).toBe("say ONE times or say $10");
  });

  test("$ARGUMENTS substituted", () => {
    expect(substitute("Run with $ARGUMENTS", { args: { $ARGUMENTS: "--force" } })).toBe("Run with --force");
  });

  test("$ARTIFACTS_DIR, $LOOP_USER_INPUT, $REJECTION_REASON", () => {
    const out = substitute("art=$ARTIFACTS_DIR in=$LOOP_USER_INPUT why=$REJECTION_REASON", {
      args: { $ARTIFACTS_DIR: "/tmp/r", $LOOP_USER_INPUT: "again", $REJECTION_REASON: "fuzzy" },
    });
    expect(out).toBe("art=/tmp/r in=again why=fuzzy");
  });

  test("builtin tokens default to empty when arg missing", () => {
    expect(substitute("[$ARTIFACTS_DIR]")).toBe("[]");
  });

  test("shell-safe escaping wraps values in single quotes", () => {
    const out = substitute("echo ${context.msg}", {
      context: { msg: "hello 'world'" },
      escapeForShell: true,
    });
    expect(out).toBe(`echo 'hello '\\''world'\\'''`);
  });

  test("shell-safe escaping handles empty substitutions", () => {
    expect(substitute("echo ${context.missing}", { escapeForShell: true })).toBe("echo ''");
  });

  test("multiple token types in one template", () => {
    const outputs = new Map<string, NodeOutput>([["plan", { success: true, output: "v1", timestamp: 0 }]]);
    const out = substitute("goal=${context.goal} plan=$plan.output arg=$1", {
      context: { goal: "ship" },
      nodeOutputs: outputs,
      args: { $1: "fast" },
    });
    expect(out).toBe("goal=ship plan=v1 arg=fast");
  });
});

describe("collectReferences", () => {
  test("finds context keys", () => {
    const refs = collectReferences("${context.a} ${context.b} ${context.a}");
    expect(refs.contextKeys.sort()).toEqual(["a", "b"]);
  });

  test("finds node ids", () => {
    const refs = collectReferences("$plan.output $review.output.score");
    expect(refs.nodeIds.sort()).toEqual(["plan", "review"]);
  });

  test("finds builtin tokens", () => {
    const refs = collectReferences("$ARTIFACTS_DIR and $ARGUMENTS");
    expect(refs.builtins.sort()).toEqual(["$ARGUMENTS", "$ARTIFACTS_DIR"]);
  });

  test("empty for plain text", () => {
    const refs = collectReferences("nothing to see here");
    expect(refs.contextKeys).toEqual([]);
    expect(refs.nodeIds).toEqual([]);
    expect(refs.builtins).toEqual([]);
  });
});
