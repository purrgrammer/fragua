import { describe, expect, test } from "bun:test";
import fc from "fast-check";
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

  test("$ARGUMENTS substituted", () => {
    expect(substitute("Run with $ARGUMENTS", { args: { $ARGUMENTS: "--force" } })).toBe("Run with --force");
  });

  test("$ARGUMENTS defaults to empty when arg missing", () => {
    expect(substitute("[$ARGUMENTS]")).toBe("[]");
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
    const out = substitute("goal=${context.goal} plan=$plan.output args=$ARGUMENTS", {
      context: { goal: "ship" },
      nodeOutputs: outputs,
      args: { $ARGUMENTS: "--fast" },
    });
    expect(out).toBe("goal=ship plan=v1 args=--fast");
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
    const refs = collectReferences("hello $ARGUMENTS world");
    expect(refs.builtins).toEqual(["$ARGUMENTS"]);
  });

  test("empty for plain text", () => {
    const refs = collectReferences("nothing to see here");
    expect(refs.contextKeys).toEqual([]);
    expect(refs.nodeIds).toEqual([]);
    expect(refs.builtins).toEqual([]);
  });
});

// ─── Property-based invariants ──────────────────────────────────────────────
//
// Generated templates are composed of plain text + tokens so the expected
// output is derivable from the inputs. Plain text uses characters that can
// never be parsed as a token (no $ or `${`) so the "no leaked token" and
// "idempotent on tokenless text" properties stay sound.

// Plain-text arbitrary excluding `$`, `\`, and word characters so we can't
// accidentally form a token boundary that would block substitution. The
// token regex guards with `(?![A-Za-z0-9_])`, so "foo$ARGUMENTSbar" doesn't
// substitute — filler must not be a word character to keep properties sound.
const plainText = fc.string({
  unit: fc.constantFrom(" ", "-", ":", "=", "\n", "/", "?", "!", "(", ")"),
  maxLength: 20,
});

describe("substitute — properties", () => {
  test("idempotent on tokenless templates", () => {
    fc.assert(
      fc.property(plainText, (t) => {
        expect(substitute(t)).toBe(t);
      }),
    );
  });

  test("$ARGUMENTS substitution leaves no literal $ARGUMENTS in output", () => {
    // `value` restricted to non-token content so we can assert on the absence
    // of `$ARGUMENTS` in the output without re-introducing it via `value`.
    const safeValue = fc.string({ unit: fc.constantFrom("a", "b", " ", "-", "x"), maxLength: 20 });
    fc.assert(
      fc.property(plainText, plainText, safeValue, (before, after, value) => {
        const tpl = `${before}$ARGUMENTS${after}`;
        const out = substitute(tpl, { args: { $ARGUMENTS: value } });
        expect(out).toBe(`${before}${value}${after}`);
        expect(out.includes("$ARGUMENTS")).toBe(false);
      }),
    );
  });

  test("missing $ARGUMENTS collapses to empty string", () => {
    fc.assert(
      fc.property(plainText, plainText, (before, after) => {
        const tpl = `${before}$ARGUMENTS${after}`;
        const out = substitute(tpl);
        expect(out).toBe(`${before}${after}`);
      }),
    );
  });

  test("collectReferences is a subset of what substitute would touch", () => {
    // For any template, every builtin returned by collectReferences must
    // appear verbatim in the input; and substitute with no args leaves
    // every context/builtin reference as "".
    fc.assert(
      fc.property(
        fc.constantFrom("${context.a} $plan.output $ARGUMENTS", "no tokens here", "${context.x.y.z}"),
        (tpl) => {
          const refs = collectReferences(tpl);
          for (const tok of refs.builtins) expect(tpl.includes(tok)).toBe(true);
          for (const key of refs.contextKeys) expect(tpl.includes(`\${context.${key}}`)).toBe(true);
          for (const id of refs.nodeIds) expect(tpl.includes(`$${id}.output`)).toBe(true);
        },
      ),
    );
  });

  test("escapeForShell output has every substituted value single-quoted", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (value) => {
        const out = substitute("v=${context.x}", { context: { x: value }, escapeForShell: true });
        // Starts with "v='" and ends with "'" after POSIX escaping.
        expect(out.startsWith("v='")).toBe(true);
        expect(out.endsWith("'")).toBe(true);
        // Every literal "'" in the input must appear in the output as the
        // POSIX close-escape-reopen sequence: '\''
        const quoteCount = (value.match(/'/g) ?? []).length;
        const escapeCount = (out.match(/'\\''/g) ?? []).length;
        expect(escapeCount).toBe(quoteCount);
      }),
    );
  });
});
