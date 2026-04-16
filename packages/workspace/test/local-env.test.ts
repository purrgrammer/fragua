import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";

describe("LocalEnvironment", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-env-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("writeFile then readFile round-trips content", async () => {
    await env.writeFile("hello.txt", "hi there");
    expect(await env.readFile("hello.txt")).toBe("hi there");
  });

  test("writeFile creates parent directories", async () => {
    await env.writeFile("a/b/c/deep.txt", "nested");
    expect(await env.readFile("a/b/c/deep.txt")).toBe("nested");
  });

  test("exists returns true/false correctly", async () => {
    expect(await env.exists("nope.txt")).toBe(false);
    await env.writeFile("yep.txt", "x");
    expect(await env.exists("yep.txt")).toBe(true);
  });

  test("exec captures stdout + stderr + exit code", async () => {
    const r = await env.exec("echo hello; echo err 1>&2; exit 3");
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("err");
    expect(r.exitCode).toBe(3);
  });

  test("exec timeout kills the process", async () => {
    const r = await env.exec("sleep 5", { timeoutMs: 200 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("timed out");
  }, 5_000);
});
