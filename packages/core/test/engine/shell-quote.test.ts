import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { substituteOutputs } from "../../src/engine/outputs-substitution.ts";
import {
  ShellContextError,
  scanShellTokenContexts,
  shellEscapeForContext,
  type UnsafeShellPosition,
} from "../../src/engine/shell-quote.ts";
import { shellReferenceContexts, substitute } from "../../src/engine/substitution.ts";
import type { OutputStructValue } from "../../src/types/outputs.ts";

function runSh(cmd: string): { stdout: string; pwned: boolean; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "fragua-shell-quote-"));
  try {
    writeFileSync(join(dir, "decoy"), "");
    const proc = Bun.spawnSync(["/bin/sh", "-c", cmd], {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/fragua-test-home" },
    });
    return {
      stdout: new TextDecoder().decode(proc.stdout),
      pwned: existsSync(join(dir, "PWNED")),
      exitCode: proc.exitCode,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALUES: Array<[string, string]> = [
  ["command substitution", "$(touch PWNED)"],
  ["backticks", "`touch PWNED`"],
  ["double quote", 'a"b'],
  ["single quote", "a'b"],
  ["backslash", "a\\b"],
  ["trailing backslash", "a\\"],
  ["backslash before $(…)", "\\$(touch PWNED)"],
  ["newline", "l1\nl2"],
  ["newline then command", "x\ntouch PWNED"],
  ["double-quote breakout", '"; touch PWNED; "'],
  ["single-quote breakout", "'; touch PWNED; '"],
  ["parameter", "$HOME"],
  ["glob", "*"],
  ["empty", ""],
];

const TEMPLATES: Array<{ ctx: string; tpl: (tok: string) => string; expect: (v: string) => string }> = [
  { ctx: "bare", tpl: (tok) => `printf '%s' ${tok}`, expect: (v) => v },
  { ctx: "double", tpl: (tok) => `printf '%s' "pre-${tok}-post"`, expect: (v) => `pre-${v}-post` },
  { ctx: "single", tpl: (tok) => `printf '%s' 'pre-${tok}-post'`, expect: (v) => `pre-${v}-post` },
];

describe("shellEscapeForContext — inputs executed through /bin/sh -c", () => {
  for (const t of TEMPLATES) {
    for (const [label, value] of VALUES) {
      test(`${t.ctx}: ${t.tpl("${{ inputs.v }}")} echoes ${label} byte-exact`, () => {
        const cmd = substitute(t.tpl("${{ inputs.v }}"), { args: { inputs: { v: value } }, escapeForShell: true });
        const r = runSh(cmd);
        expect(r.stdout).toBe(t.expect(value));
        expect(r.pwned).toBe(false);
      });
    }
  }

  for (const [label, value] of VALUES) {
    test(`double + $(…): "$(printf '%s' \${{ inputs.v }})" treats the inner token as bare (${label})`, () => {
      const tpl = `printf '%s' "$(printf '%s' \${{ inputs.v }})"`;
      const cmd = substitute(tpl, { args: { inputs: { v: value } }, escapeForShell: true });
      const r = runSh(cmd);
      expect(r.stdout).toBe(value.replace(/\n+$/, ""));
      expect(r.pwned).toBe(false);
    });
  }
});

describe("shellEscapeForContext — outputs executed through /bin/sh -c", () => {
  const record: OutputStructValue = { q: 'a"b $(touch PWNED)', s: "it's `x`", n: 1 };
  const outputValues: Array<[string, OutputStructValue, string]> = [
    ...VALUES.map(([label, v]): [string, OutputStructValue, string] => [label, v, v]),
    ["record rendered as JSON", record, JSON.stringify({ n: 1, q: 'a"b $(touch PWNED)', s: "it's `x`" })],
  ];

  for (const t of TEMPLATES) {
    for (const [label, value, rendered] of outputValues) {
      test(`${t.ctx} via substitute: ${label}`, () => {
        const cmd = substitute(t.tpl("${{ outputs.p.v }}"), {
          args: { outputs: { p: { v: value } } },
          escapeForShell: true,
        });
        const r = runSh(cmd);
        expect(r.stdout).toBe(t.expect(rendered));
        expect(r.pwned).toBe(false);
      });

      test(`${t.ctx} via substituteOutputs: ${label}`, () => {
        const cmd = substituteOutputs(t.tpl("${{ outputs.p.v }}"), { p: { v: value } }, { escapeForShell: true });
        const r = runSh(cmd);
        expect(r.stdout).toBe(t.expect(rendered));
        expect(r.pwned).toBe(false);
      });
    }
  }
});

describe("B1 — a quoted token can no longer execute $(...)", () => {
  test("B1: double-quoted token no longer executes $(...)", () => {
    const cmd = substitute('echo "x=${{ inputs.x }}"', {
      args: { inputs: { x: "$(touch PWNED)" } },
      escapeForShell: true,
    });
    expect(cmd).toBe('echo "x=\\$(touch PWNED)"');
    const r = runSh(cmd);
    expect(r.pwned).toBe(false);
    expect(r.stdout).toBe("x=$(touch PWNED)\n");
  });

  test("B1: single-quoted token no longer executes $(...)", () => {
    const cmd = substitute("echo 'x=${{ inputs.x }}'", {
      args: { inputs: { x: "'$(touch PWNED)'" } },
      escapeForShell: true,
    });
    const r = runSh(cmd);
    expect(r.pwned).toBe(false);
    expect(r.stdout).toBe("x='$(touch PWNED)'\n");
  });
});

describe("unsafe positions throw ShellContextError", () => {
  const cases: Array<[string, string, UnsafeShellPosition]> = [
    ["after a backslash", "printf '%s' \\${{ inputs.v }}", "escaped"],
    ["after a backslash inside double quotes", "printf '%s' \"\\${{ inputs.v }}\"", "escaped"],
    ["inside backticks", "echo `printf %s ${{ inputs.v }}`", "backtick"],
    ["inside backticks inside double quotes", 'echo "`printf %s ${{ inputs.v }}`"', "backtick"],
    ["inside a # comment", "true # ${{ inputs.v }}", "comment"],
    ["in a heredoc body", "cat <<EOF\nv=${{ inputs.v }}\nEOF", "heredoc"],
    ["in a quoted heredoc body", "cat <<'EOF'\n${{ inputs.v }}\nEOF", "heredoc"],
    ["in a <<- heredoc body", "cat <<-EOF\n\t${{ inputs.v }}\n\tEOF", "heredoc"],
    ["inside $'…'", "printf '%s' $'${{ inputs.v }}'", "ansi-c"],
    ["inside $((…))", "echo $(( ${{ inputs.v }} + 1 ))", "arithmetic"],
    ["directly after $ in double quotes", 'echo "Price: $${{ inputs.v }}"', "dollar-prefix"],
    ["directly after $ bare", "echo $${{ inputs.v }}", "dollar-prefix"],
  ];

  test.each(cases)("%s", (_label, tpl, position) => {
    let caught: unknown;
    try {
      substitute(tpl, { args: { inputs: { v: "1" } }, escapeForShell: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShellContextError);
    expect((caught as ShellContextError).refs).toEqual([{ ref: "${{ inputs.v }}", position }]);
  });

  test("substituteOutputs throws the same error for an output token", () => {
    expect(() => substituteOutputs("true # ${{ outputs.p.v }}", { p: { v: "x" } }, { escapeForShell: true })).toThrow(
      ShellContextError,
    );
  });

  test("without escapeForShell an unsafe position substitutes verbatim (prompts, human text)", () => {
    expect(substitute("`${{ inputs.v }}` # ${{ inputs.v }}", { args: { inputs: { v: "$(id)" } } })).toBe(
      "`$(id)` # $(id)",
    );
  });
});

describe("R2-B1/B2 — a $-prefixed token is refused", () => {
  const refusal = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return undefined;
  };

  test('R2-B1: "Price: $${{ inputs.p }}" with (echo PWNED_B1) throws ShellContextError', () => {
    const caught = refusal(() =>
      substitute('echo "Price: $${{ inputs.p }}"', {
        args: { inputs: { p: "(echo PWNED_B1)" } },
        escapeForShell: true,
      }),
    );
    expect(caught).toBeInstanceOf(ShellContextError);
    expect((caught as ShellContextError).refs).toEqual([{ ref: "${{ inputs.p }}", position: "dollar-prefix" }]);
  });

  test("R2-B2: $${{ inputs.v }} with \\'; echo PWNED_B2 # throws ShellContextError", () => {
    for (const v of ["\\'; echo PWNED_B2 #", "'; echo PWNED_B2 #"]) {
      const caught = refusal(() =>
        substitute("echo $${{ inputs.v }}", { args: { inputs: { v } }, escapeForShell: true }),
      );
      expect(caught).toBeInstanceOf(ShellContextError);
      expect((caught as ShellContextError).refs).toEqual([{ ref: "${{ inputs.v }}", position: "dollar-prefix" }]);
    }
  });

  test("substituteOutputs refuses $${{ outputs.p.v }}", () => {
    const caught = refusal(() =>
      substituteOutputs('echo "$${{ outputs.p.v }}"', { p: { v: "(echo PWNED_B1)" } }, { escapeForShell: true }),
    );
    expect(caught).toBeInstanceOf(ShellContextError);
    expect((caught as ShellContextError).refs).toEqual([{ ref: "${{ outputs.p.v }}", position: "dollar-prefix" }]);
  });
});

describe("scanShellTokenContexts", () => {
  const ctxs = (tpl: string) => shellReferenceContexts(tpl).map((r) => r.context);

  test("a backslash-escaped $ before a token is not dollar-prefix", () => {
    expect(ctxs('echo "\\$${{ inputs.a }}" \\$${{ inputs.b }}')).toEqual(["double", "bare"]);
  });

  test("a $ before a token in single quotes is dollar-prefix", () => {
    expect(ctxs("echo '$${{ inputs.a }}'")).toEqual([{ unsafe: "dollar-prefix" }]);
  });

  test("classifies bare / double / single / nested", () => {
    expect(ctxs("printf '%s' ${{ inputs.a }}")).toEqual(["bare"]);
    expect(ctxs('x="a\'b ${{ inputs.a }}"')).toEqual(["double"]);
    expect(ctxs("echo 'a\"b ${{ inputs.a }}'")).toEqual(["single"]);
    expect(ctxs('echo "$(printf %s ${{ inputs.a }}) ${{ inputs.b }}"')).toEqual(["bare", "double"]);
    expect(ctxs("echo \"$(echo '${{ inputs.a }}')\"")).toEqual(["single"]);
    expect(ctxs("echo $( (true) ; echo ${{ inputs.a }} ) ${{ inputs.b }}")).toEqual(["bare", "bare"]);
  });

  test("an escaped quote does not open a quoted region", () => {
    expect(ctxs("echo \\' ${{ inputs.a }}")).toEqual(["bare"]);
    expect(ctxs('echo "a\\"b ${{ inputs.a }}"')).toEqual(["double"]);
    expect(ctxs("echo \\\\${{ inputs.a }}")).toEqual(["bare"]);
  });

  test("a comment ends at the newline, and only starts at a word boundary", () => {
    expect(ctxs("# note\nprintf %s ${{ inputs.a }}")).toEqual(["bare"]);
    expect(ctxs("echo $# a#${{ inputs.a }}")).toEqual(["bare"]);
  });

  test("a heredoc body ends at its delimiter line", () => {
    expect(ctxs("cat <<EOF\nhi\nEOF\nprintf %s ${{ inputs.a }}")).toEqual(["bare"]);
    expect(ctxs("cat <<<${{ inputs.a }}")).toEqual(["bare"]);
  });

  test("offsets key the token start", () => {
    const tpl = "a ${{ inputs.a }} 'b ${{ inputs.b }}'";
    const map = scanShellTokenContexts(tpl, /\$\{\{\s*inputs\.[a-z]+\s*\}\}/g);
    expect(map.get(tpl.indexOf("${{ inputs.a"))).toBe("bare");
    expect(map.get(tpl.indexOf("${{ inputs.b"))).toBe("single");
  });

  test("shellEscapeForContext renders the three escapes", () => {
    expect(shellEscapeForContext("a'b", "bare")).toBe("'a'\\''b'");
    expect(shellEscapeForContext('a\\$`"b', "double")).toBe('a\\\\\\$\\`\\"b');
    expect(shellEscapeForContext("a'b", "single")).toBe("a'\\''b");
  });
});

describe("shellEscapeForContext — property", () => {
  const value = fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.string({
      unit: fc.constantFrom("$", "(", ")", "`", '"', "'", "\\", "\n", " ", "a", ";", "*", "#", "{", "}"),
      maxLength: 20,
    }),
  );

  test("property: any NUL-free string round-trips in bare, double and single", () => {
    fc.assert(
      fc.property(
        value.filter((v) => !v.includes("\0")),
        (v) => {
          const cmd = substitute("printf '%s|' ${{ inputs.v }} \"${{ inputs.v }}\" '${{ inputs.v }}'", {
            args: { inputs: { v } },
            escapeForShell: true,
          });
          const r = runSh(cmd);
          expect(r.stdout).toBe(`${v}|${v}|${v}|`);
          expect(r.pwned).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });

  test("property: a $-prefixed token throws for any value in bare, double and single", () => {
    const templates = ["printf %s $${{ inputs.v }}", 'printf %s "$${{ inputs.v }}"', "printf %s '$${{ inputs.v }}'"];
    fc.assert(
      fc.property(value, (v) => {
        for (const tpl of templates) {
          expect(() => substitute(tpl, { args: { inputs: { v } }, escapeForShell: true })).toThrow(ShellContextError);
        }
      }),
      { numRuns: 100 },
    );
  });
});
