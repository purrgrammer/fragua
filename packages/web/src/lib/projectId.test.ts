import { describe, expect, test } from "bun:test";
import { decodeProjectId, encodeProjectId } from "./projectId.ts";

describe("projectId encode/decode", () => {
  test("round-trips a typical absolute path", () => {
    const cwd = "/Users/me/work/fragua";
    expect(decodeProjectId(encodeProjectId(cwd))).toBe(cwd);
  });

  test("encoded form contains no URL-reserved characters", () => {
    const enc = encodeProjectId("/Users/me/work/fragua");
    expect(enc).not.toContain("/");
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("=");
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("survives spaces and unicode", () => {
    const cwd = "/Users/me/work/swärm prøjekt";
    expect(decodeProjectId(encodeProjectId(cwd))).toBe(cwd);
  });

  test("decode returns null for malformed input", () => {
    expect(decodeProjectId("!!!not-base64!!!")).toBeNull();
  });
});
