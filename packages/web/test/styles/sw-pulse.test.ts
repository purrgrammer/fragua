// CSS-parsing tests for the phase-synchronised sw-pulse animation.
//
// Asserts the structural invariants that make every `.sw-pulse` element
// oscillate in phase:
//
//   1. `@property --sw-pulse-opacity` is declared with `syntax: "<number>"`,
//      `inherits: true`, and `initial-value: 1`.
//   2. `:root` carries an `animation` that drives `--sw-pulse-opacity`
//      between 1 and 0.55 on the 1800ms ease-in-out cadence.
//   3. `.sw-pulse` uses `opacity: var(--sw-pulse-opacity)` and has no
//      per-element `animation` declaration of its own.
//   4. The `prefers-reduced-motion: reduce` block cancels the root
//      animation and pins `.sw-pulse` opacity to 0.7.
//
// Implementation note: we parse globals.css with plain regex — no postcss
// dependency required.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS_PATH = join(import.meta.dir, "../../src/styles/globals.css");
const css = readFileSync(CSS_PATH, "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip single-line and block comments so they don't confuse pattern matching.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const stripped = stripComments(css);

/**
 * Extract the content of a `@media (prefers-reduced-motion: reduce) { … }`
 * block. Handles one level of nesting.
 */
function extractReducedMotionBlock(src: string): string {
  const mediaRe = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard while-regex loop
  while ((match = mediaRe.exec(src)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    return src.slice(match.index + match[0].length, i - 1);
  }
  return "";
}

/**
 * Extract the body of a CSS rule block for the given selector.
 * Returns the content between the outermost `{` and `}` for the first match.
 */
function extractRuleBody(src: string, selector: string): string {
  // Escape special regex chars in the selector string.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}\\s*\\{`);
  const match = re.exec(src);
  if (!match) return "";
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(match.index + match[0].length, i - 1);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("sw-pulse CSS animation — phase synchronisation invariants", () => {
  // 1. @property declaration ------------------------------------------------

  it("declares @property --sw-pulse-opacity", () => {
    expect(stripped).toMatch(/@property\s+--sw-pulse-opacity/);
  });

  it('@property --sw-pulse-opacity has syntax: "<number>"', () => {
    const block = extractRuleBody(stripped, "@property --sw-pulse-opacity");
    expect(block).toMatch(/syntax\s*:\s*["']<number>["']/);
  });

  it("@property --sw-pulse-opacity has inherits: true", () => {
    const block = extractRuleBody(stripped, "@property --sw-pulse-opacity");
    expect(block).toMatch(/inherits\s*:\s*true/);
  });

  it("@property --sw-pulse-opacity has initial-value: 1", () => {
    const block = extractRuleBody(stripped, "@property --sw-pulse-opacity");
    expect(block).toMatch(/initial-value\s*:\s*1\b/);
  });

  // 2. :root animation -------------------------------------------------------

  it(":root has an animation declaration referencing --sw-pulse-opacity keyframes", () => {
    // The keyframe name that drives --sw-pulse-opacity should be present in
    // a :root { animation: … } declaration.
    const rootBlock = extractRuleBody(stripped, ":root");
    expect(rootBlock).toMatch(/animation\s*:/);
  });

  it(":root animation uses 1800ms (or var(--sw-duration-pulse, 1800ms))", () => {
    const rootBlock = extractRuleBody(stripped, ":root");
    // Accept either the literal or the var() form.
    expect(rootBlock).toMatch(/1800ms|--sw-duration-pulse/);
  });

  it(":root animation uses ease-in-out", () => {
    const rootBlock = extractRuleBody(stripped, ":root");
    expect(rootBlock).toMatch(/ease-in-out/);
  });

  it(":root animation uses infinite", () => {
    const rootBlock = extractRuleBody(stripped, ":root");
    expect(rootBlock).toMatch(/infinite/);
  });

  it("the keyframes that animate --sw-pulse-opacity go from 1 to 0.55", () => {
    // Find any @keyframes block that sets --sw-pulse-opacity.
    expect(stripped).toMatch(/--sw-pulse-opacity\s*:\s*0\.55/);
    expect(stripped).toMatch(/--sw-pulse-opacity\s*:\s*1\b/);
  });

  // 3. .sw-pulse reads the property — no per-element animation ---------------

  it(".sw-pulse sets opacity via var(--sw-pulse-opacity)", () => {
    // Grab the .sw-pulse block outside the reduced-motion query.
    // We look for the rule in the main stylesheet (not inside @media).
    const reducedMotionBlock = extractReducedMotionBlock(stripped);
    // Remove the reduced-motion block so we only inspect the main rule.
    const mainCss = stripped.replace(reducedMotionBlock, "");
    // Pass the raw selector — extractRuleBody handles escaping internally.
    const swPulseBlock = extractRuleBody(mainCss, ".sw-pulse");
    expect(swPulseBlock).toMatch(/opacity\s*:\s*var\(\s*--sw-pulse-opacity\s*\)/);
  });

  it(".sw-pulse does NOT have its own animation declaration (outside reduced-motion)", () => {
    const reducedMotionBlock = extractReducedMotionBlock(stripped);
    const mainCss = stripped.replace(reducedMotionBlock, "");
    // Pass the raw selector — extractRuleBody handles escaping internally.
    const swPulseBlock = extractRuleBody(mainCss, ".sw-pulse");
    // The block must not contain `animation:` or `animation-name:`.
    expect(swPulseBlock).not.toMatch(/animation\s*:/);
    expect(swPulseBlock).not.toMatch(/animation-name\s*:/);
  });

  // 4. prefers-reduced-motion block ------------------------------------------

  it("prefers-reduced-motion block cancels :root animation", () => {
    const rmBlock = extractReducedMotionBlock(stripped);
    expect(rmBlock).toBeTruthy();
    // Must contain a rule that sets animation: none on :root (or html).
    expect(rmBlock).toMatch(/:root|html/);
    expect(rmBlock).toMatch(/animation\s*:\s*none/);
  });

  it("prefers-reduced-motion block pins .sw-pulse opacity to 0.7", () => {
    const rmBlock = extractReducedMotionBlock(stripped);
    expect(rmBlock).toMatch(/\.sw-pulse/);
    expect(rmBlock).toMatch(/opacity\s*:\s*0\.7/);
  });
});
