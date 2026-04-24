import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPath, resolveReadPath, resolveToCwd, withFileMutationQueue } from "../src/path-utils.ts";

describe("expandPath", () => {
  test("strips @ prefix", () => {
    expect(expandPath("@foo/bar")).toBe("foo/bar");
  });

  test("expands ~", () => {
    const result = expandPath("~/test");
    expect(result).not.toStartWith("~");
    expect(result).toContain("test");
  });

  test("normalizes unicode spaces", () => {
    expect(expandPath("a\u00A0b")).toBe("a b");
  });

  test("passthrough for normal paths", () => {
    expect(expandPath("src/index.ts")).toBe("src/index.ts");
  });
});

describe("resolveToCwd", () => {
  test("resolves relative to cwd", () => {
    const result = resolveToCwd("foo.ts", "/project");
    expect(result).toBe("/project/foo.ts");
  });

  test("absolute path unchanged", () => {
    const result = resolveToCwd("/abs/path.ts", "/project");
    expect(result).toBe("/abs/path.ts");
  });
});

describe("resolveReadPath", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-path-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns resolved path when file exists", async () => {
    await writeFile(join(scratch, "test.txt"), "hi");
    const result = resolveReadPath("test.txt", scratch);
    expect(result).toBe(join(scratch, "test.txt"));
  });

  test("returns resolved path when file does not exist", () => {
    const result = resolveReadPath("ghost.txt", scratch);
    expect(result).toBe(join(scratch, "ghost.txt"));
  });
});

describe("withFileMutationQueue", () => {
  test("serializes operations on same file", async () => {
    const order: number[] = [];
    const op = (n: number, delayMs: number) =>
      withFileMutationQueue("/tmp/test-mutex", async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(n * 10);
      });

    await Promise.all([op(1, 20), op(2, 10)]);
    expect(order).toEqual([1, 10, 2, 20]);
  });

  test("allows parallel operations on different files", async () => {
    const order: string[] = [];
    const op = (file: string, label: string, delayMs: number) =>
      withFileMutationQueue(file, async () => {
        order.push(`${label}-start`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`${label}-end`);
      });

    await Promise.all([op("/tmp/a", "a", 20), op("/tmp/b", "b", 10)]);
    expect(order[0]).toBe("a-start");
    expect(order[1]).toBe("b-start");
  });
});
