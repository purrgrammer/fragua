import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";
import { bashTool, editFileTool, readFileTool, writeFileTool } from "../src/tools.ts";

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
    const w = await writeFileTool.execute({ path: "note.txt", content: "hi" }, env);
    expect(w.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: "note.txt" }, env);
    expect(r.text).toBe("hi");
  });

  test("read missing file returns is_error", async () => {
    const r = await readFileTool.execute({ path: "ghost.txt" }, env);
    expect(r.is_error).toBe(true);
  });

  test("read with offset and limit", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
    await writeFileTool.execute({ path: "big.txt", content: lines.join("\n") }, env);
    const r = await readFileTool.execute({ path: "big.txt", offset: 10, limit: 5 }, env);
    expect(r.text).toContain("line10");
    expect(r.text).toContain("line14");
    expect(r.text).toContain("Use offset=15 to continue");
  });

  test("read offset beyond file returns error", async () => {
    await writeFileTool.execute({ path: "small.txt", content: "one\ntwo" }, env);
    const r = await readFileTool.execute({ path: "small.txt", offset: 999 }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("beyond end of file");
  });

  test("edit single replacement", async () => {
    await writeFileTool.execute({ path: "f.ts", content: "const x = 1;\nconst y = 2;\n" }, env);
    const e = await editFileTool.execute(
      { path: "f.ts", edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }] },
      env,
    );
    expect(e.is_error).toBeUndefined();
    expect(e.text).toContain("Successfully replaced 1 block(s)");
    const r = await readFileTool.execute({ path: "f.ts" }, env);
    expect(r.text).toContain("const x = 42;");
    expect(r.text).toContain("const y = 2;");
  });

  test("edit multi-edit in one call", async () => {
    await writeFileTool.execute({ path: "m.ts", content: "aaa\nbbb\nccc\n" }, env);
    const e = await editFileTool.execute(
      {
        path: "m.ts",
        edits: [
          { oldText: "aaa", newText: "AAA" },
          { oldText: "ccc", newText: "CCC" },
        ],
      },
      env,
    );
    expect(e.is_error).toBeUndefined();
    expect(e.text).toContain("2 block(s)");
    const r = await readFileTool.execute({ path: "m.ts" }, env);
    expect(r.text).toContain("AAA");
    expect(r.text).toContain("bbb");
    expect(r.text).toContain("CCC");
  });

  test("edit fuzzy matches smart quotes", async () => {
    await writeFileTool.execute({ path: "q.txt", content: "it\u2019s a test" }, env);
    const e = await editFileTool.execute(
      { path: "q.txt", edits: [{ oldText: "it's a test", newText: "it works" }] },
      env,
    );
    expect(e.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: "q.txt" }, env);
    expect(r.text).toContain("it works");
  });

  test("edit preserves BOM and CRLF", async () => {
    const bom = "\uFEFF";
    const content = `${bom}line1\r\nline2\r\n`;
    await writeFileTool.execute({ path: "bom.txt", content }, env);
    const e = await editFileTool.execute(
      { path: "bom.txt", edits: [{ oldText: "line1", newText: "LINE1" }] },
      env,
    );
    expect(e.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: "bom.txt" }, env);
    expect(r.text).toContain("LINE1");
  });

  test("edit fails on not-found oldText", async () => {
    await writeFileTool.execute({ path: "nf.txt", content: "hello" }, env);
    const e = await editFileTool.execute(
      { path: "nf.txt", edits: [{ oldText: "goodbye", newText: "x" }] },
      env,
    );
    expect(e.is_error).toBe(true);
    expect(e.text).toContain("not found");
  });

  test("edit fails on overlapping edits", async () => {
    await writeFileTool.execute({ path: "ov.txt", content: "abcdef" }, env);
    const e = await editFileTool.execute(
      {
        path: "ov.txt",
        edits: [
          { oldText: "abcd", newText: "ABCD" },
          { oldText: "cdef", newText: "CDEF" },
        ],
      },
      env,
    );
    expect(e.is_error).toBe(true);
    expect(e.text).toContain("Overlapping");
  });

  test("bash captures stdout", async () => {
    const r = await bashTool.execute({ command: "echo hello" }, env);
    expect(r.text).toContain("hello");
    expect(r.is_error).toBe(false);
  });

  test("bash failing command flagged is_error", async () => {
    const r = await bashTool.execute({ command: "exit 1" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("exited with code 1");
  });

  test("bash timeout in seconds", async () => {
    const r = await bashTool.execute({ command: "sleep 10", timeout: 1 }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("timed out");
  });
});
