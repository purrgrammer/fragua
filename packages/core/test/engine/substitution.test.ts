import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { inputReferences, substitute } from "../../src/engine/substitution.ts";

describe("substitute", () => {
  test("no tokens → template unchanged", () => {
    expect(substitute("hello world")).toBe("hello world");
  });
});

describe("substitute — ${{ inputs.x }}", () => {
  test("named inputs substitute from the inputs map", () => {
    const out = substitute("Hello ${{ inputs.name }}, you have ${{ inputs.count }} items.", {
      args: { inputs: { name: "World", count: "5" } },
    });
    expect(out).toBe("Hello World, you have 5 items.");
  });

  test("tolerates whitespace inside the braces", () => {
    expect(substitute("${{inputs.x}} ${{   inputs.x   }}", { args: { inputs: { x: "v" } } })).toBe("v v");
  });

  test("unbound reference collapses to empty string", () => {
    expect(substitute("a=${{ inputs.missing }}b", { args: { inputs: {} } })).toBe("a=b");
    expect(substitute("a=${{ inputs.missing }}b")).toBe("a=b");
  });

  test("shell-safe escaping single-quotes input values", () => {
    const out = substitute("deploy ${{ inputs.target }}", {
      args: { inputs: { target: "a'b" } },
      escapeForShell: true,
    });
    expect(out).toBe(`deploy 'a'\\''b'`);
  });

  test("shell-safe escaping handles empty substitutions", () => {
    expect(substitute("echo ${{ inputs.x }}", { escapeForShell: true })).toBe("echo ''");
  });
});

describe("substitute — object/array inputs", () => {
  test("${{ inputs.x.field }} reads dotted into a parsed object input", () => {
    const out = substitute("env=${{ inputs.config.env }}", {
      args: { inputs: { config: { env: "prod", region: "eu" } } },
    });
    expect(out).toBe("env=prod");
  });

  test("a dotted leaf descends through nested records and arrays", () => {
    const out = substitute("${{ inputs.config.flags }}", {
      args: { inputs: { config: { flags: ["a", "b"] } } },
    });
    expect(out).toBe('["a","b"]');
  });

  test("${{ inputs.x }} renders a whole object/array input as JSON", () => {
    expect(substitute("${{ inputs.tags }}", { args: { inputs: { tags: ["a", "b"] } } })).toBe('["a","b"]');
    expect(substitute("${{ inputs.config }}", { args: { inputs: { config: { env: "dev" } } } })).toBe('{"env":"dev"}');
  });

  test("scalar ${{ inputs.x }} stays verbatim (regression)", () => {
    expect(substitute("${{ inputs.name }}", { args: { inputs: { name: "World" } } })).toBe("World");
  });

  test("an unresolvable dotted path collapses to '' (inputs are lenient)", () => {
    expect(substitute("a=${{ inputs.config.missing }}b", { args: { inputs: { config: { env: "x" } } } })).toBe("a=b");
  });
});

describe("inputReferences", () => {
  test("extracts every reference name, deduped", () => {
    expect(inputReferences("a=${{ inputs.foo }} b=${{ inputs.bar }} c=${{ inputs.foo }}")).toEqual(["foo", "bar"]);
  });

  test("a dotted object-input ref yields only the base name (the declared input)", () => {
    expect(inputReferences("${{ inputs.config.env }} ${{ inputs.config.region }}")).toEqual(["config"]);
  });

  test("empty for templates with no input refs", () => {
    expect(inputReferences("plain text")).toEqual([]);
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

  test("input substitution leaves no literal token in output", () => {
    const safeValue = fc.string({ unit: fc.constantFrom("a", "b", " ", "-", "x"), maxLength: 20 });
    fc.assert(
      fc.property(plainText, plainText, safeValue, (before, after, value) => {
        const tpl = `${before}\${{ inputs.v }}${after}`;
        const out = substitute(tpl, { args: { inputs: { v: value } } });
        expect(out).toBe(`${before}${value}${after}`);
        expect(out.includes("${{ inputs.v }}")).toBe(false);
      }),
    );
  });

  test("missing input collapses to empty string", () => {
    fc.assert(
      fc.property(plainText, plainText, (before, after) => {
        const tpl = `${before}\${{ inputs.v }}${after}`;
        const out = substitute(tpl);
        expect(out).toBe(`${before}${after}`);
      }),
    );
  });

  test("escapeForShell output has every substituted value single-quoted", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (value) => {
        const out = substitute("v=${{ inputs.v }}", { args: { inputs: { v: value } }, escapeForShell: true });
        expect(out.startsWith("v='")).toBe(true);
        expect(out.endsWith("'")).toBe(true);
        const quoteCount = (value.match(/'/g) ?? []).length;
        const escapeCount = (out.match(/'\\''/g) ?? []).length;
        expect(escapeCount).toBe(quoteCount);
      }),
    );
  });
});
