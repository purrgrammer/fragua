import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";
import { bashTool, readFileTool, writeFileTool } from "../src/tools.ts";

describe("core tools", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-tools-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("write → read round-trip", async () => {
    const w = await writeFileTool.execute({ path: "note.txt", contents: "hi" }, env);
    expect(w.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: "note.txt" }, env);
    expect(r.text).toBe("hi");
  });

  test("read missing file returns is_error", async () => {
    const r = await readFileTool.execute({ path: "ghost.txt" }, env);
    expect(r.is_error).toBe(true);
  });

  test("bash captures stdout", async () => {
    const r = await bashTool.execute({ command: "echo hello" }, env);
    expect(r.text).toContain("hello");
    expect(r.is_error).toBe(false);
  });

  test("bash failing command flagged is_error", async () => {
    const r = await bashTool.execute({ command: "exit 1" }, env);
    expect(r.is_error).toBe(true);
  });
});
