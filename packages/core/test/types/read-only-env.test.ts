import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "../../src/types/execution.ts";
import { makeReadOnlyEnv, ReadOnlyEnvError } from "../../src/types/read-only-env.ts";

function fullEnv(): ExecutionEnvironment {
  const files = new Map<string, string>();
  files.set("/a/b.txt", "hello");
  return {
    cwd: () => "/a",
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    exists: async (p) => files.has(p),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    listDir: async () => [],
    glob: async () => [],
  };
}

describe("makeReadOnlyEnv", () => {
  test("reads pass through", async () => {
    const ro = makeReadOnlyEnv(fullEnv());
    expect(ro.cwd()).toBe("/a");
    expect(await ro.readFile("/a/b.txt")).toBe("hello");
    expect(await ro.exists("/a/b.txt")).toBe(true);
    expect(await ro.listDir("/a")).toEqual([]);
    expect(await ro.glob("**/*")).toEqual([]);
  });

  test("writeFile throws ReadOnlyEnvError", async () => {
    const ro = makeReadOnlyEnv(fullEnv());
    expect(() => ro.writeFile("/a/x.txt", "nope")).toThrow(ReadOnlyEnvError);
  });

  test("exec throws ReadOnlyEnvError", async () => {
    const ro = makeReadOnlyEnv(fullEnv());
    expect(() => ro.exec("echo nope")).toThrow(ReadOnlyEnvError);
  });

  test("underlying env is not mutated when writes are attempted", async () => {
    const inner = fullEnv();
    const ro = makeReadOnlyEnv(inner);
    try {
      ro.writeFile("/a/x.txt", "nope");
    } catch {
      // expected
    }
    expect(await inner.exists("/a/x.txt")).toBe(false);
  });
});
