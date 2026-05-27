import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { inputReferences, substitute, substituteArgv } from "../../src/engine/substitution.ts";

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

describe("inputReferences", () => {
  test("extracts every reference name, deduped", () => {
    expect(inputReferences("a=${{ inputs.foo }} b=${{ inputs.bar }} c=${{ inputs.foo }}")).toEqual(["foo", "bar"]);
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

describe("substituteArgv", () => {
  test("no tokens — passthrough unchanged", () => {
    const result = substituteArgv({ cmd: "jq", args: [".name", "in.json"] });
    expect(result).toEqual({ cmd: "jq", args: [".name", "in.json"] });
  });

  test("substitutes cmd and each args element independently", () => {
    const result = substituteArgv(
      { cmd: "${{ inputs.bin }}", args: ["${{ inputs.filter }}", "${{ inputs.file }}"] },
      { args: { inputs: { bin: "jq", filter: ".name", file: "out.json" } } },
    );
    expect(result).toEqual({ cmd: "jq", args: [".name", "out.json"] });
  });

  test("per-element: a value with spaces stays one argv element (no re-split)", () => {
    const result = substituteArgv(
      { cmd: "echo", args: ["${{ inputs.msg }}"] },
      { args: { inputs: { msg: "hello world\nrm -rf /" } } },
    );
    expect(result.args).toHaveLength(1);
    expect(result.args[0]).toBe("hello world\nrm -rf /");
  });

  test("per-element: shell metacharacters are inert (not interpreted)", () => {
    const dangerous = "$(whoami); rm -rf / | cat && echo `id` 'quote'\"'";
    const result = substituteArgv(
      { cmd: "printf", args: ["%s", "${{ inputs.val }}"] },
      { args: { inputs: { val: dangerous } } },
    );
    expect(result.args[1]).toBe(dangerous);
  });

  test("cmd substitution gives a single token even when value contains a path with spaces", () => {
    const result = substituteArgv(
      { cmd: "${{ inputs.bin }}", args: [] },
      { args: { inputs: { bin: "/usr/local/bin/my tool" } } },
    );
    expect(result.cmd).toBe("/usr/local/bin/my tool");
  });

  test("unresolved reference collapses to empty string (same as substitute)", () => {
    const result = substituteArgv({ cmd: "jq", args: ["${{ inputs.missing }}"] }, { args: { inputs: {} } });
    expect(result.args[0]).toBe("");
  });

  test("no shell-quoting applied — value with single quotes is verbatim", () => {
    const result = substituteArgv(
      { cmd: "echo", args: ["${{ inputs.v }}"] },
      { args: { inputs: { v: "it's a test" } } },
    );
    expect(result.args[0]).toBe("it's a test");
  });

  test("property: substituteArgv never alters the number of argv elements", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 30 }), { minLength: 0, maxLength: 5 }),
        fc.string({ maxLength: 30 }),
        (args, value) => {
          const result = substituteArgv(
            { cmd: "echo", args: args.map(() => "${{ inputs.v }}") },
            { args: { inputs: { v: value } } },
          );
          expect(result.args).toHaveLength(args.length);
        },
      ),
    );
  });
});
