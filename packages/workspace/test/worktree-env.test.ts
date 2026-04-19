import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "abc" });
    await env.init();
    expect(existsSync(env.worktreePath)).toBe(true);
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches.stdout).toContain("swarm/abc");

    await env.dispose();
    expect(existsSync(env.worktreePath)).toBe(false);
    const branchesAfter = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branchesAfter.stdout).not.toContain("swarm/abc");
  });

  test("writeFile in worktree does not touch repoRoot files", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "xyz" });
    await env.init();
    try {
      await env.writeFile("hello.txt", "only in worktree");
      expect(existsSync(join(env.worktreePath, "hello.txt"))).toBe(true);
      expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  test("no symlinks by default — worktree is a clean checkout", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "clean" });
    await env.init();
    try {
      // node_modules must NOT exist after init (no bootstrap was set)
      expect(existsSync(join(env.worktreePath, "node_modules"))).toBe(false);
    } finally {
      await env.dispose();
    }
  });

  test("bootstrap string runs in worktree, marks bootstrapRan", async () => {
    const env = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "boot-ok",
      bootstrap: "echo ran > bootstrap.log",
    });
    await env.init();
    try {
      expect(env.bootstrapRan).toBe(true);
      expect(env.bootstrapCommand).toBe("echo ran > bootstrap.log");
      expect(existsSync(join(env.worktreePath, "bootstrap.log"))).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test("bootstrap callback receives the env and can write files", async () => {
    let receivedCwd = "";
    const env = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "boot-cb",
      bootstrap: async (e) => {
        receivedCwd = e.cwd();
        await e.writeFile("from-callback.txt", "hi");
      },
    });
    await env.init();
    try {
      expect(env.bootstrapRan).toBe(true);
      expect(receivedCwd).toBe(env.worktreePath);
      expect(existsSync(join(env.worktreePath, "from-callback.txt"))).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test("bootstrap non-zero exit fails init()", async () => {
    const env = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "boot-fail",
      bootstrap: "exit 7",
    });
    let error: Error | undefined;
    try {
      await env.init();
    } catch (err) {
      error = err as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toContain("bootstrap command failed");
    expect(error?.message).toContain("exit 7");
    await env.dispose();
  });

  test("logDir is created under init()", async () => {
    const logDir = join(repo, "custom-logs", "run-1");
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "logs", logDir });
    await env.init();
    try {
      expect(existsSync(logDir)).toBe(true);
      expect(env.logDir).toBe(logDir);
    } finally {
      await env.dispose();
    }
  });

  test("keepAfterDispose preserves the worktree for inspection", async () => {
    const env = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "keep",
      keepAfterDispose: true,
    });
    await env.init();
    const path = env.worktreePath;
    try {
      await env.writeFile("artifact.txt", "post-mortem");
      await env.dispose();
      expect(existsSync(path)).toBe(true);
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", path], { stdio: "ignore" });
      spawnSync("git", ["-C", repo, "branch", "-D", "swarm/keep"], { stdio: "ignore" });
    }
  });

  test("exec runs in the worktree cwd", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "exec" });
    await env.init();
    try {
      const r = await env.exec("pwd");
      expect(r.stdout.trim().endsWith(env.worktreePath)).toBe(true);
    } finally {
      await env.dispose();
    }
  });

  test("blocklist passes through from LocalEnvironment", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "block" });
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
