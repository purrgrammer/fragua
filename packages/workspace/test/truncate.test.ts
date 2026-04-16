import { describe, expect, test } from "bun:test";
import { truncate } from "../src/truncate.ts";

describe("truncate — char-first-then-line", () => {
  test("short input passes through", () => {
    expect(truncate("hello", { max_chars: 100, mode: "tail" })).toBe("hello");
  });

  test("tail mode keeps the end", () => {
    const out = truncate("a".repeat(200), { max_chars: 50, mode: "tail" });
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith("a".repeat(50))).toBe(true);
    expect(out).toContain("WARNING");
  });

  test("head_tail mode keeps both ends", () => {
    const input = `${"x".repeat(500)}SEAM${"y".repeat(500)}`;
    const out = truncate(input, { max_chars: 100, mode: "head_tail" });
    expect(out.startsWith("x")).toBe(true);
    expect(out.endsWith("y")).toBe(true);
    expect(out).toContain("WARNING");
  });

  test("line cap applied after char cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
    const out = truncate(many, { max_chars: 10_000, mode: "tail", max_lines: 20 });
    expect(out.split("\n").length).toBeLessThanOrEqual(22); // 20 + warning + maybe trailing empty
    expect(out).toContain("omitted");
  });

  test("char truncation beats line truncation on giant single line", () => {
    const singleLine = "z".repeat(10_000);
    const out = truncate(singleLine, { max_chars: 100, mode: "tail", max_lines: 50 });
    expect(out.length).toBeLessThan(singleLine.length);
  });
});
