import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { collectReferences, substitute } from "../../src/engine/substitution.ts";

describe("substitute", () => {
  test("no tokens → template unchanged", () => {
    expect(substitute("hello world")).toBe("hello world");
  });

  test("$ARGUMENTS substituted", () => {
    expect(substitute("Run with $ARGUMENTS", { args: { $ARGUMENTS: "--force" } })).toBe("Run with --force");
  });

  test("$ARGUMENTS defaults to empty when arg missing", () => {
    expect(substitute("[$ARGUMENTS]")).toBe("[]");
  });

  test("shell-safe escaping wraps values in single quotes", () => {
    const out = substitute("echo $ARGUMENTS", {
      args: { $ARGUMENTS: "hello 'world'" },
      escapeForShell: true,
    });
    expect(out).toBe(`echo 'hello '\\''world'\\'''`);
  });

  test("shell-safe escaping handles empty substitutions", () => {
    expect(substitute("echo $ARGUMENTS", { escapeForShell: true })).toBe("echo ''");
  });
});

describe("collectReferences", () => {
  test("finds builtin tokens", () => {
    const refs = collectReferences("hello $ARGUMENTS world");
    expect(refs.builtins).toEqual(["$ARGUMENTS"]);
  });

  test("empty for plain text", () => {
    const refs = collectReferences("nothing to see here");
    expect(refs.builtins).toEqual([]);
  });
});

// ─── Property-based invariants ──────────────────────────────────────────────
//
// Generated templates are composed of plain text + tokens so the expected
// output is derivable from the inputs.

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

  test("escapeForShell output has every substituted value single-quoted", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (value) => {
        const out = substitute("v=$ARGUMENTS", { args: { $ARGUMENTS: value }, escapeForShell: true });
        expect(out.startsWith("v='")).toBe(true);
        expect(out.endsWith("'")).toBe(true);
        const quoteCount = (value.match(/'/g) ?? []).length;
        const escapeCount = (out.match(/'\\''/g) ?? []).length;
        expect(escapeCount).toBe(quoteCount);
      }),
    );
  });
});
