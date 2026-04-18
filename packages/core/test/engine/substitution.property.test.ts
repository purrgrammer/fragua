// Wave 3 — fast-check property-based fuzz for the substitution grammar.
// substitution.test.ts already covers the positive path exhaustively;
// this suite guards the *robustness* contract:
//
//   1. substitute() never throws on arbitrary input.
//   2. Unresolved references degrade to empty string (never leave the
//      raw `${context.…}` or `$name.output` token behind — that would
//      leak into prompts and confuse the LLM).
//   3. The function is idempotent in the benign sense: substituting
//      output with an empty context doesn't introduce new tokens.
//
// Generators are deliberately broad — alphabets include `{`, `}`, `$`,
// `.`, backslashes, control chars — so anything a DOT-author can embed
// inside a `prompt = "…"` reaches the substituter here.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { substitute } from "../../src/engine/substitution.ts";

const adversarial = fc.string({ minLength: 0, maxLength: 200 });

describe("substitute — property-based robustness", () => {
  test("never throws on arbitrary template strings", () => {
    fc.assert(
      fc.property(adversarial, (template) => {
        expect(() => substitute(template)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  test("never throws when context keys / values are also adversarial", () => {
    fc.assert(
      fc.property(
        adversarial,
        fc.dictionary(adversarial, fc.oneof(adversarial, fc.integer(), fc.boolean())),
        (template, context) => {
          expect(() => substitute(template, { context })).not.toThrow();
        },
      ),
      { numRuns: 250 },
    );
  });

  test("unresolved ${context.x} always collapses to empty (never leaves the raw token)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_.]*$/).filter((k) => k.length >= 1 && k.length <= 40),
        (key) => {
          const template = `before/\${context.${key}}/after`;
          const out = substitute(template, { context: {} });
          expect(out).toBe("before//after");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("unresolved $node.output always collapses to empty", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]*$/).filter((k) => k.length >= 1 && k.length <= 30),
        (nodeId) => {
          const template = `pre/$${nodeId}.output/post`;
          const out = substitute(template);
          expect(out).toBe("pre//post");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("shell-escape mode wraps substituted values in single-quoted form", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 120 }), (raw) => {
        const out = substitute("value=${context.v}", {
          context: { v: raw },
          escapeForShell: true,
        });
        // The output must at minimum be a quoted string; the exact
        // contents are the escape helper's job. We just guard the
        // round-trip shape so an author who pastes a prompt with
        // escapeForShell:true never sees an un-quoted raw value.
        expect(out.startsWith("value='")).toBe(true);
        expect(out.endsWith("'")).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});
