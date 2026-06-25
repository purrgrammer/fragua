import { describe, expect, test } from "bun:test";
import { extractDeclarations, normalizeSource } from "../src/index.ts";

describe("extractDeclarations", () => {
  const src = [
    "export type A = { x: number };",
    "const B = 1;",
    "export async function c() { return 1; }",
    "class D {}",
    "enum E { a, b }",
    "interface F { y: string }",
  ].join("\n");

  test("slices a named decl up to the next top-level boundary", () => {
    const out = extractDeclarations(src, ["A"], "t");
    expect(out).toContain("type A = { x: number }");
    expect(out).not.toContain("const B");
  });

  test("recognizes async function, class, and enum as boundaries", () => {
    // Without these keywords in the boundary regex, slicing `c` would run past
    // the class/enum/interface decls and absorb them into the hash.
    const out = extractDeclarations(src, ["c"], "t");
    expect(out).toContain("async function c()");
    expect(out).not.toContain("class D");
    expect(out).not.toContain("enum E");
  });

  test("throws a renamed-decl error when a name is missing", () => {
    expect(() => extractDeclarations(src, ["Nope"], "gate")).toThrow(/gate: declaration 'Nope' not found/);
  });
});

describe("normalizeSource", () => {
  test("drops comments and collapses whitespace", () => {
    const out = normalizeSource("const x = 1; // line\n/* block */ const   y = 2;");
    expect(out).toBe("const x = 1; const y = 2;");
  });
});
