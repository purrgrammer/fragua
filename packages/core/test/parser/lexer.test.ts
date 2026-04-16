import { describe, expect, test } from "bun:test";
import { LexError, tokenize } from "../../src/parser/lexer.ts";

describe("tokenize", () => {
  test("empty source → single EOF token", () => {
    const t = tokenize("");
    expect(t).toHaveLength(1);
    expect(t[0]!.type).toBe("EOF");
  });

  test("recognises keywords", () => {
    const t = tokenize("digraph subgraph graph node edge");
    expect(t.slice(0, 5).map((x) => [x.type, x.value])).toEqual([
      ["KEYWORD", "digraph"],
      ["KEYWORD", "subgraph"],
      ["KEYWORD", "graph"],
      ["KEYWORD", "node"],
      ["KEYWORD", "edge"],
    ]);
  });

  test("identifier vs keyword", () => {
    const t = tokenize("foo digraph foo_bar");
    expect(t[0]!.type).toBe("IDENT");
    expect(t[1]!.type).toBe("KEYWORD");
    expect(t[2]!.type).toBe("IDENT");
    expect(t[2]!.value).toBe("foo_bar");
  });

  test("punctuation", () => {
    const t = tokenize("{}[],;=");
    expect(t.slice(0, 6).map((x) => x.type)).toEqual(["LBRACE", "RBRACE", "LBRACKET", "RBRACKET", "COMMA", "SEMI"]);
    expect(t[6]!.type).toBe("EQUALS");
  });

  test("arrow -> produces ARROW token", () => {
    const t = tokenize("a -> b");
    expect(t[1]!.type).toBe("ARROW");
  });

  test("quoted string with escapes", () => {
    const t = tokenize(`"hello \\"world\\" \\n end"`);
    expect(t[0]!.type).toBe("STRING");
    expect(t[0]!.value).toBe('hello "world" \n end');
  });

  test("string concatenation with +", () => {
    const t = tokenize(`"foo" + "bar"`);
    expect(t[0]!.type).toBe("STRING");
    expect(t[0]!.value).toBe("foobar");
  });

  test("numbers: integers, floats, negatives", () => {
    const t = tokenize("42 3.14 -7 0.5");
    expect(t.slice(0, 4).map((x) => [x.type, x.value])).toEqual([
      ["NUMBER", "42"],
      ["NUMBER", "3.14"],
      ["NUMBER", "-7"],
      ["NUMBER", "0.5"],
    ]);
  });

  test("line comments skipped", () => {
    const t = tokenize("a // this is a comment\nb");
    expect(t.slice(0, 2).map((x) => x.value)).toEqual(["a", "b"]);
  });

  test("block comments skipped and preserve line count", () => {
    const t = tokenize("a /* multi\nline\ncomment */ b");
    expect(t[0]!.line).toBe(1);
    expect(t[1]!.line).toBe(3);
  });

  test("line/column tracking after newlines", () => {
    const t = tokenize("a\nb\n  c");
    expect(t[0]).toMatchObject({ line: 1, col: 1 });
    expect(t[1]).toMatchObject({ line: 2, col: 1 });
    expect(t[2]).toMatchObject({ line: 3, col: 3 });
  });

  test("unterminated string throws LexError", () => {
    expect(() => tokenize(`"unterminated`)).toThrow(LexError);
  });

  test("unterminated block comment throws LexError", () => {
    expect(() => tokenize("/* never ends")).toThrow(LexError);
  });

  test("unexpected character throws LexError", () => {
    expect(() => tokenize("~")).toThrow(LexError);
  });
});
