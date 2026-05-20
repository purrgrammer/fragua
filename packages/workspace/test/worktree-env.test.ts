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

  test("init creates a detached worktree, captures baseGitSha, no branch yet", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "abc" });
    await env.init();
    expect(existsSync(env.worktreePath)).toBe(true);

    // No `swarm/runs/abc` branch exists at provision time — branch is lazy.
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches.stdout).not.toContain("swarm/runs/abc");

    // baseGitSha matches main HEAD.
    const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(env.baseGitSha).toBe(head);

    // baseGitRef matches the source repo's current branch (the post-run
    // merge/commit target default).
    const ref = spawnSync("git", ["-C", repo, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(env.baseGitRef).toBe(ref);

    await env.dispose();
  });

  test("init records baseGitRef = null when the source repo is on a detached HEAD", async () => {
    spawnSync("git", ["-C", repo, "checkout", "--detach", "HEAD"], { encoding: "utf8" });
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "detached-run" });
    await env.init();
    expect(env.baseGitSha).not.toBeNull();
    expect(env.baseGitRef).toBeNull();
    await env.dispose();
  });

  test("dispose on a clean worktree removes everything, branch never exists", async () => {
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "clean-run" });
    await env.init();

    await env.dispose();
    expect(existsSync(env.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches.stdout).not.toContain("swarm/runs/clean-run");
  });

  test("dispose removes the worktree and creates NO branch, even with committed + dirty + untracked work", async () => {
    // Work preservation is the snapshotter's job now (refs/swarm/snapshots +
    // heads, captured before dispose). Dispose just tears down — it no longer
    // inspects the tree or creates a porcelain swarm/runs branch.
    const env = new WorktreeEnvironment({ repoRoot: repo, runId: "teardown-run" });
    await env.init();
    await env.writeFile("feature.ts", "export const x = 1;\n");
    await env.exec(
      "git add -A && git -c user.email=node@swarm -c user.name=node commit --no-gpg-sign -m 'in-worktree commit'",
    );
    await env.writeFile("dirty.ts", "export const u = 2;\n"); // uncommitted
    await env.writeFile("brand-new.log", "untracked output"); // untracked

    await env.dispose();
    expect(existsSync(env.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", repo, "branch"], { encoding: "utf8" });
    expect(branches.stdout).not.toContain("swarm/runs/teardown-run");
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

  test("init is idempotent across process restarts — reuses existing worktree", async () => {
    // Simulate a daemon restart: the first env init()s, then a fresh
    // env instance (no shared state) calls init() against the same
    // runId. The branch + dir already exist on disk, so init() must
    // reuse them rather than re-run `git worktree add` (which would
    // fail because the branch is already checked out).
    let bootstrapCount = 0;
    const first = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "resume",
      bootstrap: async () => {
        bootstrapCount++;
      },
    });
    await first.init();
    expect(bootstrapCount).toBe(1);
    expect(first.bootstrapRan).toBe(true);

    // Pretend the daemon restarted — construct a new env with the
    // same runId. init() should observe the existing worktree and
    // skip `git worktree add` + bootstrap.
    const second = new WorktreeEnvironment({
      repoRoot: repo,
      runId: "resume",
      bootstrap: async () => {
        bootstrapCount++;
      },
    });
    await second.init();
    expect(bootstrapCount).toBe(1); // bootstrap NOT rerun on resume
    expect(second.bootstrapRan).toBe(false); // marker reflects no fresh bootstrap this instance

    await second.dispose();
    expect(existsSync(second.worktreePath)).toBe(false);
  });
});
