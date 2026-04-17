// Tests for `swarm run --input-file <path>` — concatenation semantics.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMergedInput } from "../src/commands/run.ts";

describe("buildMergedInput — --input + --input-file merge", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-inputfile-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("undefined when both --input and --input-file are absent", async () => {
    const result = await buildMergedInput({ workflow: "x.dot" });
    expect(result).toBeUndefined();
  });

  test("single --input-file → `===== <path> =====\\n<body>`", async () => {
    const specPath = join(scratch, "spec.md");
    await writeFile(specPath, "build feature X\nwith details", "utf8");

    const result = await buildMergedInput({
      workflow: "x.dot",
      inputFiles: [specPath],
      cwd: scratch,
    });

    expect(result).toContain(`===== ${specPath} =====`);
    expect(result).toContain("build feature X");
    expect(result).toContain("with details");
  });

  test("relative path resolves against cwd", async () => {
    const specPath = join(scratch, "rel.md");
    await writeFile(specPath, "RELATIVE_CONTENT", "utf8");

    const result = await buildMergedInput({
      workflow: "x.dot",
      inputFiles: ["rel.md"],
      cwd: scratch,
    });

    expect(result).toContain("===== rel.md =====");
    expect(result).toContain("RELATIVE_CONTENT");
  });

  test("multiple --input-file concat in order with double-newline separator", async () => {
    const a = join(scratch, "a.md");
    const b = join(scratch, "b.md");
    await writeFile(a, "AAA_BODY", "utf8");
    await writeFile(b, "BBB_BODY", "utf8");

    const result = await buildMergedInput({
      workflow: "x.dot",
      inputFiles: [a, b],
      cwd: scratch,
    });

    expect(result).toBeDefined();
    const text = result as string;
    const idxA = text.indexOf("AAA_BODY");
    const idxB = text.indexOf("BBB_BODY");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
    // Each file appears under its own header
    expect(text).toContain(`===== ${a} =====`);
    expect(text).toContain(`===== ${b} =====`);
    // Blocks are separated by blank line
    expect(text).toContain("\n\n===== ");
  });

  test("--input combined with --input-file: raw input first, files after", async () => {
    const specPath = join(scratch, "spec.md");
    await writeFile(specPath, "FILE_MARKER", "utf8");

    const result = await buildMergedInput({
      workflow: "x.dot",
      input: "RAW_INPUT_MARKER",
      inputFiles: [specPath],
      cwd: scratch,
    });

    const text = result as string;
    const rawIdx = text.indexOf("RAW_INPUT_MARKER");
    const headerIdx = text.indexOf("===== ");
    const fileIdx = text.indexOf("FILE_MARKER");
    expect(rawIdx).toBeGreaterThan(-1);
    expect(rawIdx).toBeLessThan(headerIdx);
    expect(headerIdx).toBeLessThan(fileIdx);
  });

  test("--input only (no files) returns the raw input unchanged", async () => {
    const result = await buildMergedInput({
      workflow: "x.dot",
      input: "just a one-line task",
    });
    expect(result).toBe("just a one-line task");
  });

  test('missing --input-file returns "error"', async () => {
    const result = await buildMergedInput({
      workflow: "x.dot",
      inputFiles: [join(scratch, "does-not-exist.md")],
      cwd: scratch,
    });
    expect(result).toBe("error");
  });

  test("UTF-8 content with newlines preserved verbatim", async () => {
    const specPath = join(scratch, "multi.md");
    const body = "line1\nline2\nline3\n\nparagraph2";
    await writeFile(specPath, body, "utf8");

    const result = await buildMergedInput({
      workflow: "x.dot",
      inputFiles: [specPath],
      cwd: scratch,
    });
    expect(result).toContain(body);
  });
});
