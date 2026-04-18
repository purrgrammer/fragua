import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyPatchError, applyPatch, parsePatch } from "../src/apply-patch.ts";
import { LocalEnvironment } from "../src/local-env.ts";
import { applyPatchTool } from "../src/tools.ts";

describe("parsePatch", () => {
  test("rejects missing Begin Patch sentinel", () => {
    expect(() => parsePatch("*** Update File: a.ts\n+foo\n*** End Patch\n")).toThrow(/Begin Patch/);
  });

  test("rejects missing End Patch sentinel", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Update File: a.ts\n")).toThrow(/End Patch/);
  });

  test("parses a simple update with one hunk", () => {
    const ops = parsePatch(
      ["*** Begin Patch", "*** Update File: a.ts", " ctx", "-old", "+new", "*** End Patch"].join("\n"),
    );
    expect(ops).toEqual([
      {
        op: "update",
        path: "a.ts",
        hunks: [
          {
            lines: [
              { kind: "context", text: "ctx" },
              { kind: "remove", text: "old" },
              { kind: "add", text: "new" },
            ],
          },
        ],
      },
    ]);
  });

  test("parses Add File and Delete File", () => {
    const ops = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: new.ts",
        "+line1",
        "+line2",
        "*** Delete File: gone.ts",
        "*** End Patch",
      ].join("\n"),
    );
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ op: "add", path: "new.ts", content: "line1\nline2\n" });
    expect(ops[1]).toEqual({ op: "delete", path: "gone.ts" });
  });

  test("rejects Move File directive", () => {
    expect(() =>
      parsePatch(["*** Begin Patch", "*** Move File: a.ts -> b.ts", "*** End Patch"].join("\n")),
    ).toThrow(/Move File/);
  });

  test("parses multiple hunks separated by @@ with anchor", () => {
    const ops = parsePatch(
      [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@ class Foo",
        " pass",
        "-x",
        "+y",
        "@@ class Bar",
        " pass",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n"),
    );
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.op !== "update") throw new Error("expected update");
    expect(op.hunks).toHaveLength(2);
    expect(op.hunks[0]?.anchor).toBe("class Foo");
    expect(op.hunks[1]?.anchor).toBe("class Bar");
  });
});

describe("applyPatch (applier)", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-patch-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("single-hunk update rewrites the file", async () => {
    await writeFile(join(scratch, "a.ts"), "line1\nOLD\nline3\n");
    const patch = ["*** Begin Patch", "*** Update File: a.ts", " line1", "-OLD", "+NEW", " line3", "*** End Patch"].join(
      "\n",
    );
    const r = await applyPatch(patch, env);
    expect(r.files_changed).toHaveLength(1);
    expect(await readFile(join(scratch, "a.ts"), "utf-8")).toBe("line1\nNEW\nline3\n");
  });

  test("multi-hunk update with @@ anchor applies both hunks", async () => {
    await writeFile(
      join(scratch, "a.ts"),
      "class Foo\n    def m():\n        return 1\n\nclass Bar\n    def m():\n        return 1\n",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@ class Foo",
      "     def m():",
      "-        return 1",
      "+        return 42",
      "@@ class Bar",
      "     def m():",
      "-        return 1",
      "+        return 99",
      "*** End Patch",
    ].join("\n");
    await applyPatch(patch, env);
    const updated = await readFile(join(scratch, "a.ts"), "utf-8");
    expect(updated).toContain("class Foo\n    def m():\n        return 42");
    expect(updated).toContain("class Bar\n    def m():\n        return 99");
  });

  test("add file creates the file", async () => {
    const patch = ["*** Begin Patch", "*** Add File: new.ts", "+hello", "+world", "*** End Patch"].join("\n");
    await applyPatch(patch, env);
    expect(await readFile(join(scratch, "new.ts"), "utf-8")).toBe("hello\nworld\n");
  });

  test("add file fails if path already exists", async () => {
    await writeFile(join(scratch, "x.ts"), "existing");
    const patch = ["*** Begin Patch", "*** Add File: x.ts", "+new content", "*** End Patch"].join("\n");
    await expect(applyPatch(patch, env)).rejects.toThrow(/already exists/);
    // existing file untouched
    expect(await readFile(join(scratch, "x.ts"), "utf-8")).toBe("existing");
  });

  test("delete file removes the file", async () => {
    await writeFile(join(scratch, "gone.ts"), "bye");
    const patch = ["*** Begin Patch", "*** Delete File: gone.ts", "*** End Patch"].join("\n");
    await applyPatch(patch, env);
    expect(await env.exists("gone.ts")).toBe(false);
  });

  test("delete file fails if path does not exist", async () => {
    const patch = ["*** Begin Patch", "*** Delete File: missing.ts", "*** End Patch"].join("\n");
    await expect(applyPatch(patch, env)).rejects.toThrow(/does not exist/);
  });

  test("ambiguous hunk (matches more than once) fails without writing", async () => {
    await writeFile(join(scratch, "a.ts"), "FOO\nFOO\n");
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-FOO", "+BAR", "*** End Patch"].join("\n");
    await expect(applyPatch(patch, env)).rejects.toThrow(/more than once/);
    expect(await readFile(join(scratch, "a.ts"), "utf-8")).toBe("FOO\nFOO\n");
  });

  test("atomic pre-validation: add succeeds only after a failing update does not land", async () => {
    // First op (update) will fail — second op (add) must not run either.
    await writeFile(join(scratch, "a.ts"), "line1\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "-nonexistent",
      "+replacement",
      "*** Add File: b.ts",
      "+should not be created",
      "*** End Patch",
    ].join("\n");
    await expect(applyPatch(patch, env)).rejects.toThrow(/context not found/);
    expect(await env.exists("b.ts")).toBe(false);
    expect(await readFile(join(scratch, "a.ts"), "utf-8")).toBe("line1\n");
  });

  test("anchor narrows search to disambiguate identical blocks", async () => {
    await writeFile(
      join(scratch, "a.ts"),
      "region-A\nVALUE\nend-A\nregion-B\nVALUE\nend-B\n",
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "@@ region-B",
      "-VALUE",
      "+CHANGED",
      "*** End Patch",
    ].join("\n");
    await applyPatch(patch, env);
    expect(await readFile(join(scratch, "a.ts"), "utf-8")).toBe(
      "region-A\nVALUE\nend-A\nregion-B\nCHANGED\nend-B\n",
    );
  });

  test("hunk with no context but unique removed line succeeds", async () => {
    await writeFile(join(scratch, "a.ts"), "keep\nUNIQUE\nkeep\n");
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-UNIQUE", "+REPLACED", "*** End Patch"].join("\n");
    await applyPatch(patch, env);
    expect(await readFile(join(scratch, "a.ts"), "utf-8")).toBe("keep\nREPLACED\nkeep\n");
  });

  test("throws when parse produces zero ops", () => {
    expect(() => parsePatch("*** Begin Patch\n*** End Patch")).toThrow(/no file operations/);
  });
});

describe("local:apply_patch tool", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-apt-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns a per-file summary on success", async () => {
    await writeFile(join(scratch, "a.ts"), "OLD\n");
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-OLD", "+NEW", "*** End Patch"].join("\n");
    const r = await applyPatchTool.execute({ patch }, env);
    expect(r.is_error).toBeFalsy();
    expect(r.text).toContain("~ a.ts");
    const data = r.data as { files_changed: Array<{ path: string; op: string }> } | undefined;
    expect(data?.files_changed[0]?.path).toBe("a.ts");
    expect(data?.files_changed[0]?.op).toBe("update");
  });

  test("returns is_error with parser message on malformed patch", async () => {
    const r = await applyPatchTool.execute({ patch: "not a patch" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("Begin Patch");
  });

  test("returns is_error when a hunk does not match", async () => {
    await writeFile(join(scratch, "a.ts"), "actual\n");
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-missing", "+new", "*** End Patch"].join("\n");
    const r = await applyPatchTool.execute({ patch }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("context not found");
  });
});

// Keep the unused import from tree-shaking-eager linters honest.
export type _ = ApplyPatchError;
