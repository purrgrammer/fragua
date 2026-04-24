import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine, truncateTail } from "../src/truncate-v2.ts";

describe("truncateHead", () => {
  test("short content passes through", () => {
    const r = truncateHead("hello\nworld");
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("hello\nworld");
    expect(r.totalLines).toBe(2);
    expect(r.outputLines).toBe(2);
  });

  test("truncates by line limit", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const r = truncateHead(lines.join("\n"), { maxLines: 10, maxBytes: 1_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.outputLines).toBe(10);
    expect(r.totalLines).toBe(100);
    expect(r.content).toContain("line0");
    expect(r.content).toContain("line9");
    expect(r.content).not.toContain("line10");
  });

  test("truncates by byte limit", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(100));
    const r = truncateHead(lines.join("\n"), { maxLines: 10_000, maxBytes: 350 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.outputLines).toBeLessThan(10);
  });

  test("first line exceeds byte limit", () => {
    const r = truncateHead("x".repeat(200_000), { maxBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.firstLineExceedsLimit).toBe(true);
    expect(r.content).toBe("");
    expect(r.outputLines).toBe(0);
  });

  test("uses default limits", () => {
    expect(DEFAULT_MAX_LINES).toBe(2000);
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
  });
});

describe("truncateTail", () => {
  test("short content passes through", () => {
    const r = truncateTail("hello\nworld");
    expect(r.truncated).toBe(false);
    expect(r.content).toBe("hello\nworld");
  });

  test("keeps last N lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const r = truncateTail(lines.join("\n"), { maxLines: 10, maxBytes: 1_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.outputLines).toBe(10);
    expect(r.content).toContain("line99");
    expect(r.content).toContain("line90");
    expect(r.content).not.toContain("line89");
  });

  test("keeps last N bytes", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${"x".repeat(100)}${i}`);
    const r = truncateTail(lines.join("\n"), { maxLines: 10_000, maxBytes: 350 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.content).toContain("9");
  });

  test("partial last line when single line exceeds limit", () => {
    const r = truncateTail("x".repeat(200), { maxBytes: 50, maxLines: 10_000 });
    expect(r.truncated).toBe(true);
    expect(r.lastLinePartial).toBe(true);
    expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(50);
  });
});

describe("truncateLine", () => {
  test("short line passes through", () => {
    const r = truncateLine("hello");
    expect(r.text).toBe("hello");
    expect(r.wasTruncated).toBe(false);
  });

  test("long line truncated with marker", () => {
    const r = truncateLine("x".repeat(600), 500);
    expect(r.wasTruncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(510 + 11);
    expect(r.text).toContain("[truncated]");
  });
});

describe("formatSize", () => {
  test("bytes", () => expect(formatSize(500)).toBe("500B"));
  test("kilobytes", () => expect(formatSize(51200)).toBe("50KB"));
  test("megabytes", () => expect(formatSize(1_500_000)).toBe("1.4MB"));
});
