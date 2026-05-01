import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";
import { lsTool } from "../src/ls.ts";

describe("lsTool", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-ls-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("entries sorted alphabetical case-insensitive with `/` on dirs", async () => {
    await writeFile(join(scratch, "a.txt"), "");
    await mkdir(join(scratch, "B"), { recursive: true });
    await writeFile(join(scratch, "c.txt"), "");
    const r = await lsTool.execute({}, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text.split("\n")).toEqual(["a.txt", "B/", "c.txt"]);
    expect(r.data?.entries).toBe(3);
  });

  test("missing path returns is_error", async () => {
    const r = await lsTool.execute({ path: "ghost" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("Path not found");
  });

  test("not-a-directory returns is_error", async () => {
    await writeFile(join(scratch, "file.txt"), "hi");
    const r = await lsTool.execute({ path: "file.txt" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("Not a directory");
  });

  test("limit=2 caps entries and reports entry_limit_reached", async () => {
    for (const name of ["a", "b", "c", "d"]) {
      await writeFile(join(scratch, name), "");
    }
    const r = await lsTool.execute({ limit: 2 }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.data?.entries).toBe(2);
    expect(r.data?.entry_limit_reached).toBe(2);
    expect(r.text).toContain("2 entries limit reached");
  });

  test("empty directory message", async () => {
    const r = await lsTool.execute({}, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toBe("(empty directory)");
    expect(r.data?.entries).toBe(0);
  });
});
