import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../src/grep.ts";
import { LocalEnvironment } from "../src/local-env.ts";

describe("grepTool", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fragua-grep-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("basic literal match prints path:line: text", async () => {
    await writeFile(join(scratch, "a.txt"), "hello world\nthis is fine\n");
    await writeFile(join(scratch, "b.txt"), "no match here\n");
    const r = await grepTool.execute({ pattern: "hello" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("a.txt:1: hello world");
    expect(r.text).not.toContain("b.txt");
    expect(r.data?.matches).toBe(1);
  });

  test("glob filter restricts file set", async () => {
    await writeFile(join(scratch, "x.ts"), "needle in ts\n");
    await writeFile(join(scratch, "y.md"), "needle in md\n");
    const r = await grepTool.execute({ pattern: "needle", glob: "*.ts" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("x.ts");
    expect(r.text).not.toContain("y.md");
    expect(r.data?.matches).toBe(1);
  });

  test("ignoreCase matches mixed case", async () => {
    await writeFile(join(scratch, "f.txt"), "hello\nHELLO\nHeLLo\n");
    const r = await grepTool.execute({ pattern: "Hello", ignoreCase: true }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.matches).toBe(3);
  });

  test("literal=true treats regex metachars as text", async () => {
    await writeFile(join(scratch, "f.txt"), "axb\na.b\nacb\n");
    const r = await grepTool.execute({ pattern: "a.b", literal: true }, env);
    expect(r.is_error).toBeUndefined();
    // Only the literal "a.b" line; "axb" / "acb" must not match.
    expect(r.data?.matches).toBe(1);
    expect(r.text).toContain("f.txt:2: a.b");
  });

  test("context=2 includes surrounding lines with `-` separator", async () => {
    await writeFile(join(scratch, "f.txt"), "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n");
    const r = await grepTool.execute({ pattern: "FOUR", context: 2 }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("f.txt-2- two");
    expect(r.text).toContain("f.txt-3- three");
    expect(r.text).toContain("f.txt:4: FOUR");
    expect(r.text).toContain("f.txt-5- five");
    expect(r.text).toContain("f.txt-6- six");
  });

  test("limit=2 caps matches and reports match_limit_reached", async () => {
    await writeFile(join(scratch, "f.txt"), "x\nx\nx\nx\nx\n");
    const r = await grepTool.execute({ pattern: "x", limit: 2 }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.matches).toBe(2);
    expect(r.data?.match_limit_reached).toBe(2);
    expect(r.text).toContain("2 matches limit reached");
  });

  test("skips binary files (null byte sniff in first 1KB)", async () => {
    await writeFile(join(scratch, "bin.dat"), "needle\0buried\n");
    const r = await grepTool.execute({ pattern: "needle" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.matches).toBe(0);
    expect(r.text).toBe("No matches found");
  });

  test("skips default-ignored dirs (node_modules, .git, dist)", async () => {
    await mkdir(join(scratch, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(scratch, "node_modules", "pkg", "x.ts"), "needle\n");
    await mkdir(join(scratch, ".git"), { recursive: true });
    await writeFile(join(scratch, ".git", "config"), "needle\n");
    await mkdir(join(scratch, "dist"), { recursive: true });
    await writeFile(join(scratch, "dist", "out.js"), "needle\n");
    await writeFile(join(scratch, "src.ts"), "needle\n");
    const r = await grepTool.execute({ pattern: "needle" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("src.ts:1: needle");
    expect(r.text).not.toContain("node_modules");
    expect(r.text).not.toContain(".git");
    expect(r.text).not.toContain("dist/");
    expect(r.data?.matches).toBe(1);
  });

  test("missing path returns is_error", async () => {
    const r = await grepTool.execute({ pattern: "x", path: "ghost" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("Path not found");
  });

  test("path scopes search to subdirectory and reports relative paths", async () => {
    await mkdir(join(scratch, "sub"), { recursive: true });
    await writeFile(join(scratch, "sub", "a.txt"), "hello world\n");
    await writeFile(join(scratch, "top.txt"), "hello also at top\n");
    const r = await grepTool.execute({ pattern: "hello", path: "sub" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.matches).toBe(1);
    // Output paths must be relative to searchRoot (`sub`), not env.cwd().
    expect(r.text).toContain("a.txt:1: hello world");
    expect(r.text).not.toContain("sub/a.txt");
    expect(r.text).not.toContain("top.txt");
  });

  test("searches dotfiles and hidden directories (rg --hidden parity)", async () => {
    await writeFile(join(scratch, ".env"), "secret=needle\n");
    await writeFile(join(scratch, ".gitignore"), "node_modules\n");
    await mkdir(join(scratch, ".github", "workflows"), { recursive: true });
    await writeFile(join(scratch, ".github", "workflows", "ci.yml"), "needle: true\n");
    await writeFile(join(scratch, "regular.txt"), "needle here too\n");
    const r = await grepTool.execute({ pattern: "needle" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain(".env:1: secret=needle");
    expect(r.text).toContain(".github/workflows/ci.yml:1: needle: true");
    expect(r.text).toContain("regular.txt:1: needle here too");
    expect(r.data?.matches).toBe(3);
  });
});
