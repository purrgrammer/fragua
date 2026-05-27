// CSS-parsing tests for the sw-pulse animation.
//
// Earlier this drove an inheritable CSS custom property animated on
// `:root` ("one clock for the whole document"). Cute, but pinned a CPU
// core at ~70% on `Recalculate style` because the animated, inheriting
// property invalidated every descendant 60×/sec. The animation now runs
// directly on `.sw-pulse` elements with plain `opacity`, which is a
// compositor-only property — zero per-frame style-recalc cost.
//
// These tests assert the structural invariants of the new design:
//
//   1. There is NO `:root` animation declaration.
//   2. There is NO `@property --sw-pulse-opacity` (the cascading
//      mechanism it enabled is gone).
//   3. `.sw-pulse` carries its own `animation` referencing
//      `sw-pulse-tick` on the 1800ms ease-in-out infinite cadence.
//   4. The keyframes animate `opacity` between 1 and 0.55.
//   5. The `prefers-reduced-motion: reduce` block cancels the
//      animation on `.sw-pulse` and pins opacity to 0.7.
//
// Implementation note: we parse globals.css with plain regex — no postcss
// dependency required.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(import.meta.dirname, "../../src/styles/globals.css");
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

describe("sw-pulse CSS animation — compositor-only opacity invariants", () => {
  // 1. The old cascading-property design must be gone -----------------------

  it("does NOT register @property --sw-pulse-opacity", () => {
    // The old design relied on an inherited animated custom property; if
    // it ever comes back it'd reintroduce the document-wide style-recalc
    // storm.
    expect(stripped).not.toMatch(/@property\s+--sw-pulse-opacity/);
  });

  it("does NOT animate :root", () => {
    const rootBlock = extractRuleBody(stripped, ":root");
    // :root may still exist for tokens / CSS variables, but must not
    // declare an `animation` of its own.
    expect(rootBlock).not.toMatch(/animation\s*:/);
  });

  // 2. .sw-pulse runs its own opacity animation -----------------------------

  it(".sw-pulse declares an animation referencing sw-pulse-tick", () => {
    const reducedMotionBlock = extractReducedMotionBlock(stripped);
    const mainCss = stripped.replace(reducedMotionBlock, "");
    const swPulseBlock = extractRuleBody(mainCss, ".sw-pulse");
    expect(swPulseBlock).toMatch(/animation\s*:[^;]*sw-pulse-tick/);
  });

  it(".sw-pulse animation uses 1800ms (literal or via var(--sw-duration-pulse, 1800ms))", () => {
    const reducedMotionBlock = extractReducedMotionBlock(stripped);
    const mainCss = stripped.replace(reducedMotionBlock, "");
    const swPulseBlock = extractRuleBody(mainCss, ".sw-pulse");
    expect(swPulseBlock).toMatch(/1800ms|--sw-duration-pulse/);
  });

  it(".sw-pulse animation uses ease-in-out infinite", () => {
    const reducedMotionBlock = extractReducedMotionBlock(stripped);
    const mainCss = stripped.replace(reducedMotionBlock, "");
    const swPulseBlock = extractRuleBody(mainCss, ".sw-pulse");
    expect(swPulseBlock).toMatch(/ease-in-out/);
    expect(swPulseBlock).toMatch(/infinite/);
  });

  // 3. Keyframes animate opacity, not a custom property ---------------------

  it("the @keyframes sw-pulse-tick block animates opacity (compositor-only)", () => {
    // The whole point of the rewrite: opacity is compositor-only, so the
    // animation runs on the GPU with no style-recalc cost. If someone
    // re-introduces a custom-property keyframe here the perf regression
    // returns.
    const keyframeBlock = extractRuleBody(stripped, "@keyframes sw-pulse-tick");
    expect(keyframeBlock).toMatch(/opacity\s*:/);
    expect(keyframeBlock).not.toMatch(/--sw-pulse-opacity/);
  });

  it("keyframes go from opacity 1 to opacity 0.55", () => {
    const keyframeBlock = extractRuleBody(stripped, "@keyframes sw-pulse-tick");
    expect(keyframeBlock).toMatch(/opacity\s*:\s*1\b/);
    expect(keyframeBlock).toMatch(/opacity\s*:\s*0\.55/);
  });

  // 4. prefers-reduced-motion block -----------------------------------------

  it("prefers-reduced-motion block cancels the .sw-pulse animation", () => {
    const rmBlock = extractReducedMotionBlock(stripped);
    expect(rmBlock).toBeTruthy();
    expect(rmBlock).toMatch(/\.sw-pulse/);
    expect(rmBlock).toMatch(/animation\s*:\s*none/);
  });

  it("prefers-reduced-motion block pins .sw-pulse opacity to 0.7", () => {
    const rmBlock = extractReducedMotionBlock(stripped);
    expect(rmBlock).toMatch(/opacity\s*:\s*0\.7/);
  });
});
