import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeEnvironment } from "../src/worktree-env.ts";

function gitInitRepo(dir: string): void {
  spawnSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@test"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "user.name", "test"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
}

function gitCommit(dir: string, message: string): void {
  spawnSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", dir, "commit", "-m", message], { stdio: "ignore" });
}

describe("WorktreeEnvironment", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "swarm-wt-"));
    gitInitRepo(repo);
    await writeFile(join(repo, "README.md"), "# test\n");
    gitCommit(repo, "init");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("init creates worktree + branch, dispose removes both", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "abc", shareIgnored: [] });
    await env.init();
    expect(existsSync(env.worktreePath)).toBe(true);
    // Branch exists
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches.stdout).toContain("swarm/abc");

    await env.dispose();
    expect(existsSync(env.worktreePath)).toBe(false);
    const branchesAfter = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branchesAfter.stdout).not.toContain("swarm/abc");
  });

  test("writeFile in worktree does not touch repoRoot files", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "xyz", shareIgnored: [] });
    await env.init();
    try {
      await env.writeFile("hello.txt", "only in worktree");
      expect(existsSync(join(env.worktreePath, "hello.txt"))).toBe(true);
      expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  test("shareIgnored symlinks ignored directories into the worktree", async () => {
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "console.log(1)");

    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "syml", shareIgnored: ["node_modules"] });
    await env.init();
    try {
      expect(existsSync(join(env.worktreePath, "node_modules", "pkg", "index.js"))).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test("keepAfterDispose preserves the worktree for inspection", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "keep", shareIgnored: [], keepAfterDispose: true });
    await env.init();
    const path = env.worktreePath;
    try {
      await env.writeFile("artifact.txt", "post-mortem");
      await env.dispose();
      expect(existsSync(path)).toBe(true);
    } finally {
      // manual cleanup for the test
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "branch", "-D", "swarm/keep"], { stdio: "ignore" });
    }
  });

  test("exec runs in the worktree cwd", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "exec", shareIgnored: [] });
    await env.init();
    try {
      const r = await env.exec("pwd");
      // macOS tmpdirs resolve to /private/var/... via symlink; compare suffix
      expect(r.stdout.trim().endsWith(env.worktreePath)).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test("blocklist passes through from LocalEnvironment", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "block", shareIgnored: [] });
    await env.init();
    try {
      const r = await env.exec("sudo echo hi");
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toContain("blocked");
    } finally {
      await env.dispose();
    }
  });
});
