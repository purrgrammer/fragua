import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTool } from "../src/find.ts";
import { LocalEnvironment } from "../src/local-env.ts";

describe("findTool", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-find-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns paths matching glob pattern", async () => {
    await mkdir(join(scratch, "src"), { recursive: true });
    await writeFile(join(scratch, "src", "a.ts"), "");
    await writeFile(join(scratch, "src", "b.ts"), "");
    await writeFile(join(scratch, "src", "c.md"), "");
    const r = await findTool.execute({ pattern: "**/*.ts" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("src/a.ts");
    expect(r.text).toContain("src/b.ts");
    expect(r.text).not.toContain("c.md");
    expect(r.data?.matches).toBe(2);
  });

  test("path option scopes search to subdirectory", async () => {
    await mkdir(join(scratch, "src"), { recursive: true });
    await mkdir(join(scratch, "other"), { recursive: true });
    await writeFile(join(scratch, "src", "a.ts"), "");
    await writeFile(join(scratch, "other", "b.ts"), "");
    const r = await findTool.execute({ pattern: "*.ts", path: "src" }, env);
    expect(r.is_error).toBeUndefined();
    // Output is relative to searchRoot — plain `a.ts`, not `src/a.ts`.
    expect(r.text.split("\n")).toEqual(["a.ts"]);
    expect(r.text).not.toContain("src/");
    expect(r.text).not.toContain("b.ts");
    expect(r.data?.matches).toBe(1);
  });

  test("default ignore set excludes node_modules and .git", async () => {
    await mkdir(join(scratch, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(scratch, "node_modules", "pkg", "x.ts"), "");
    await mkdir(join(scratch, ".git"), { recursive: true });
    await writeFile(join(scratch, ".git", "y.ts"), "");
    await writeFile(join(scratch, "src.ts"), "");
    const r = await findTool.execute({ pattern: "**/*.ts" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("src.ts");
    expect(r.text).not.toContain("node_modules");
    expect(r.text).not.toContain(".git");
    expect(r.data?.matches).toBe(1);
  });

  test("limit=2 caps results and reports result_limit_reached", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await writeFile(join(scratch, name), "");
    }
    const r = await findTool.execute({ pattern: "*.ts", limit: 2 }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.matches).toBe(2);
    expect(r.data?.result_limit_reached).toBe(2);
    expect(r.text).toContain("2 results limit reached");
  });

  test("missing path returns is_error", async () => {
    const r = await findTool.execute({ pattern: "*.ts", path: "ghost" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("Path not found");
  });
});
