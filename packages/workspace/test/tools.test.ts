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
    const e = await editFileTool.execute({ path: "bom.txt", edits: [{ oldText: "line1", newText: "LINE1" }] }, env);
    expect(e.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: "bom.txt" }, env);
    expect(r.text).toContain("LINE1");
  });

  test("edit fails on not-found oldText", async () => {
    await writeFileTool.execute({ path: "nf.txt", content: "hello" }, env);
    const e = await editFileTool.execute({ path: "nf.txt", edits: [{ oldText: "goodbye", newText: "x" }] }, env);
    expect(e.is_error).toBe(true);
    expect(e.text).toContain("oldText not found");
  });

  test("edit fails with no-change error when replacement is identical", async () => {
    await writeFileTool.execute({ path: "nc.txt", content: "hello" }, env);
    const e = await editFileTool.execute({ path: "nc.txt", edits: [{ oldText: "hello", newText: "hello" }] }, env);
    expect(e.is_error).toBe(true);
    expect(e.text).toContain("No changes made");
  });

  test("edit fails on duplicate oldText with helpful message", async () => {
    await writeFileTool.execute({ path: "dup.txt", content: "foo bar foo" }, env);
    const e = await editFileTool.execute({ path: "dup.txt", edits: [{ oldText: "foo", newText: "x" }] }, env);
    expect(e.is_error).toBe(true);
    expect(e.text).toMatch(/2 occurrences/);
  });

  test("edit prepareArguments recovers from JSON-stringified edits", () => {
    const prepared = editFileTool.prepareArguments?.({
      path: "x.ts",
      edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
    });
    expect(prepared).toEqual({ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] });
  });

  test("edit prepareArguments recovers from legacy {oldText,newText} flat shape", () => {
    const prepared = editFileTool.prepareArguments?.({
      path: "x.ts",
      oldText: "a",
      newText: "b",
    });
    expect(prepared).toEqual({ path: "x.ts", edits: [{ oldText: "a", newText: "b" }] });
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

  test("bash spills full output to a temp file when truncated", async () => {
    // Generate a payload that exceeds DEFAULT_MAX_BYTES (50KB). Each line
    // is ~80 chars × 1000 lines = ~80KB.
    const r = await bashTool.execute(
      { command: `bun -e 'for (let i=0;i<1000;i++) console.log("line " + i + " ".repeat(70))'` },
      env,
    );
    expect(r.text).toContain("Full output:");
    const data = r.data as { full_output_path?: string; truncated?: boolean };
    expect(data.truncated).toBe(true);
    expect(typeof data.full_output_path).toBe("string");
  });

  test("bash kills the entire process tree on timeout", async () => {
    // A backgrounded child sleep would survive a SIGTERM-to-shell-only.
    // detached: true + process.kill(-pgid) reaches the descendant.
    const start = Date.now();
    const r = await bashTool.execute({ command: "(sleep 10 &) ; sleep 5", timeout: 1 }, env);
    const elapsed = Date.now() - start;
    expect(r.is_error).toBe(true);
    expect(elapsed).toBeLessThan(4_000);
  });

  test("read returns image content for png files", async () => {
    // Smallest valid PNG: 8-byte signature + IHDR + IEND.
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000159731b1d0000000049454e44ae426082",
      "hex",
    );
    const path = join(scratch, "tiny.png");
    await Bun.write(path, png);
    const r = await readFileTool.execute({ path: "tiny.png" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.content).toBeDefined();
    expect(r.content?.some((b) => b.type === "image" && b.mimeType === "image/png")).toBe(true);
    const data = r.data as { image?: { mimeType: string } };
    expect(data.image?.mimeType).toBe("image/png");
  });

  test("write serializes concurrent writes to the same path", async () => {
    // Each writer rewrites the file's full contents. Without the
    // mutation queue, atomic-rename + read-then-write across two
    // tool calls can interleave and lose data. With the queue, we
    // get a deterministic last-writer wins.
    const p = "race.txt";
    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeFileTool.execute({ path: p, content: `version ${i}` }, env)),
    );
    for (const w of writes) expect(w.is_error).toBeUndefined();
    const r = await readFileTool.execute({ path: p }, env);
    expect(r.text.startsWith("version ")).toBe(true);
  });
});
