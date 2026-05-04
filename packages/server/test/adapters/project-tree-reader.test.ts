// Unit tests for the FsProjectTreeReader adapter. Covers the two list
// strategies (git ls-files vs. dir-walk) and every readBlob guard
// (traversal, oversize, binary).

import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFsProjectTreeReader } from "../../src/adapters/project-tree-reader.ts";

const execFileAsync = promisify(execFile);

async function setupGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swarm-tree-git-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: root });

  await writeFile(join(root, "README.md"), "# hi\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export {};\n");

  // node_modules/foo.js is created on disk but excluded by .gitignore.
  await writeFile(join(root, ".gitignore"), "node_modules\n");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "foo.js"), "module.exports = 1;\n");

  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

async function setupPlainDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "swarm-tree-plain-"));
  await writeFile(join(root, "a.txt"), "alpha\n");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "b.txt"), "beta\n");
  // Dot-dirs (e.g. simulating `.git`) are skipped by the walk fallback.
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

describe("project-tree-reader", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop() as string;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honours .gitignore via git ls-files when cwd is a git repo", async () => {
    const root = await setupGitRepo();
    cleanups.push(root);
    const reader = createFsProjectTreeReader();
    const entries = await reader.list(root);

    const paths = entries.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    // `src` directory is implied by the file list and folded in.
    expect(entries.some((e) => e.path === "src" && e.type === "dir")).toBe(true);
    // Ignored file MUST be absent — the listing is gitignore-honored.
    expect(paths).not.toContain("node_modules/foo.js");
  });

  test("falls back to recursive dir-walk when cwd is not a git repo", async () => {
    const root = await setupPlainDir();
    cleanups.push(root);
    const reader = createFsProjectTreeReader();
    const entries = await reader.list(root);

    const paths = entries.map((e) => e.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("nested/b.txt");
    expect(entries.some((e) => e.path === "nested" && e.type === "dir")).toBe(true);
    // Dot-dir contents are skipped.
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths).not.toContain(".git");
  });

  test("rejects path traversal: `..` segment and absolute paths", async () => {
    const root = await setupPlainDir();
    cleanups.push(root);
    const reader = createFsProjectTreeReader();

    const a = await reader.readBlob(root, "../etc/passwd");
    expect(a.kind).toBe("invalid_path");
    const b = await reader.readBlob(root, "/etc/passwd");
    expect(b.kind).toBe("invalid_path");
    const c = await reader.readBlob(root, "nested/../../escape");
    expect(c.kind).toBe("invalid_path");
  });

  test("readBlob refuses files >1MB", async () => {
    const root = await setupPlainDir();
    cleanups.push(root);
    // 1 MiB + 1 byte — just over the cap.
    const big = Buffer.alloc(1024 * 1024 + 1, 65);
    await writeFile(join(root, "big.txt"), big);
    const reader = createFsProjectTreeReader();
    const result = await reader.readBlob(root, "big.txt");
    expect(result.kind).toBe("too_large");
  });

  test("readBlob refuses binary files", async () => {
    const root = await setupPlainDir();
    cleanups.push(root);
    await writeFile(join(root, "bin.dat"), Buffer.from([0x48, 0x00, 0x49, 0x00]));
    const reader = createFsProjectTreeReader();
    const result = await reader.readBlob(root, "bin.dat");
    expect(result.kind).toBe("binary");
  });

  test("readBlob returns utf-8 text for a normal file", async () => {
    const root = await setupPlainDir();
    cleanups.push(root);
    const reader = createFsProjectTreeReader();
    const result = await reader.readBlob(root, "a.txt");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.text).toBe("alpha\n");
  });
});
