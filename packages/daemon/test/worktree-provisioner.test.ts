// WorktreeProvisioner — lifecycle invariants + per-run env decision.
//
// Two test surfaces here:
//
//   A. Lifecycle (uses the `factory` injection point — no git
//      subprocesses, deterministic):
//        1. `ensure(runId)` is idempotent — repeat calls return the
//           same cached env without re-invoking the factory.
//        2. Concurrent `ensure` calls for the same runId dedupe to a
//           single factory invocation (no double-provisioning).
//        3. `ensure` failures don't poison the cache — a retry calls
//           the factory again.
//        4. `dispose` evicts the cache so a subsequent `ensure`
//           reprovisions.
//        5. `envFor` surfaces the cached env synchronously without
//           provisioning.
//        6. `dispose` on an unknown runId is a no-op (idempotent
//           across lifecycle ordering).
//
//   B. Per-run env decision (real `git init` + `git worktree add` in
//      temp dirs — slower, but the only way to cover the regression
//      fix: a daemon serves runs from many cwds, and the provisioner
//      picks worktree-vs-local per run against the *run's* cwd, never
//      the daemon's startup pwd).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionEnvironment } from "@swarm/core";
import { LocalEnvironment, WorktreeEnvironment } from "@swarm/workspace";
import { WorktreeProvisioner } from "../src/worktree-provisioner.ts";

function stubEnv(cwd: string): ExecutionEnvironment {
  return {
    cwd: () => cwd,
    projectCwd: () => cwd,
    readFile: async () => "",
    writeFile: async () => {},
    exists: async () => false,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    listDir: async () => [],
    glob: async () => [],
  };
}

describe("WorktreeProvisioner", () => {
  test("ensure is idempotent (same env returned on repeat calls)", async () => {
    let calls = 0;
    const p = new WorktreeProvisioner({
      factory: async (runId) => {
        calls++;
        return stubEnv(`/fake/${runId}`);
      },
    });

    const a = await p.ensure("r1");
    const b = await p.ensure("r1");
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  test("concurrent ensure calls dedupe", async () => {
    let calls = 0;
    const p = new WorktreeProvisioner({
      factory: async (runId) => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return stubEnv(`/fake/${runId}`);
      },
    });

    const [a, b, c] = await Promise.all([p.ensure("r1"), p.ensure("r1"), p.ensure("r1")]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls).toBe(1);
  });

  test("ensure failure does not poison the cache", async () => {
    let calls = 0;
    const p = new WorktreeProvisioner({
      factory: async (runId) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return stubEnv(`/fake/${runId}`);
      },
    });

    await expect(p.ensure("r1")).rejects.toThrow("boom");
    const env = await p.ensure("r1");
    expect(env.cwd()).toBe("/fake/r1");
    expect(calls).toBe(2);
  });

  test("dispose evicts the cache so ensure reprovisions", async () => {
    let calls = 0;
    const p = new WorktreeProvisioner({
      factory: async (runId) => {
        calls++;
        return stubEnv(`/fake/${runId}/${calls}`);
      },
    });

    const a = await p.ensure("r1");
    await p.dispose("r1");
    const b = await p.ensure("r1");
    expect(a).not.toBe(b);
    expect(calls).toBe(2);
  });

  test("envFor is a synchronous peek after ensure", async () => {
    const p = new WorktreeProvisioner({
      factory: async (runId) => stubEnv(`/fake/${runId}`),
    });
    expect(p.envFor("r1")).toBeUndefined();
    await p.ensure("r1");
    expect(p.envFor("r1")?.cwd()).toBe("/fake/r1");
  });

  test("dispose on an unknown runId is a no-op (returns null branch)", async () => {
    const p = new WorktreeProvisioner({
      factory: async (runId) => stubEnv(`/fake/${runId}`),
    });
    await expect(p.dispose("never-existed")).resolves.toEqual({ branch: null });
  });

  test("dispose on a factory-produced env (not a WorktreeEnvironment) returns null branch", async () => {
    const p = new WorktreeProvisioner({
      factory: async (runId) => stubEnv(`/fake/${runId}`),
    });
    await p.ensure("r1");
    await expect(p.dispose("r1")).resolves.toEqual({ branch: null });
    expect(p.envFor("r1")).toBeUndefined();
  });
});

describe("WorktreeProvisioner — bootstrap resolution", () => {
  test("no resolver, no constructor bootstrap → empty pair", async () => {
    const p = new WorktreeProvisioner();
    expect(await p.resolveBootstrapFor("/any/cwd")).toEqual({});
  });

  test("no resolver → constructor values pass through", async () => {
    const p = new WorktreeProvisioner({
      bootstrap: "default-cmd",
      bootstrapTimeoutMs: 1234,
    });
    expect(await p.resolveBootstrapFor("/any/cwd")).toEqual({
      bootstrap: "default-cmd",
      bootstrapTimeoutMs: 1234,
    });
  });

  test("resolver is authoritative — no fallback to constructor bootstrap", async () => {
    // Constructor sets defaults; resolver returns empty. The empty
    // resolver result must win, not the constructor — that's the
    // "local or nothing" guarantee that prevents the daemon's
    // startup-cwd bootstrap from leaking into other projects.
    const p = new WorktreeProvisioner({
      bootstrap: "should-not-leak",
      bootstrapTimeoutMs: 999,
      resolveRunBootstrap: async () => ({}),
    });
    expect(await p.resolveBootstrapFor("/project/a")).toEqual({});
  });

  test("resolver receives the run cwd and its return is used verbatim", async () => {
    const seen: string[] = [];
    const p = new WorktreeProvisioner({
      resolveRunBootstrap: async (cwd) => {
        seen.push(cwd);
        if (cwd === "/project/a") return { bootstrap: "cmd-a", bootstrapTimeoutMs: 100 };
        if (cwd === "/project/b") return { bootstrap: "cmd-b" };
        return {};
      },
    });
    expect(await p.resolveBootstrapFor("/project/a")).toEqual({
      bootstrap: "cmd-a",
      bootstrapTimeoutMs: 100,
    });
    expect(await p.resolveBootstrapFor("/project/b")).toEqual({ bootstrap: "cmd-b" });
    expect(await p.resolveBootstrapFor("/project/c")).toEqual({});
    expect(seen).toEqual(["/project/a", "/project/b", "/project/c"]);
  });
});

describe("WorktreeProvisioner — per-run worktree-vs-local fallback", () => {
  // The daemon serves runs from many cwds. The provisioner type is decided
  // per run against the run's own cwd — NOT once, at boot, against the
  // daemon's startup pwd. A run whose cwd isn't a git repo gets a
  // LocalEnvironment rooted at *that run's* cwd; the daemon's pwd is
  // irrelevant. Regression: a daemon launched outside a git repo was
  // previously locked into a single shared LocalEnvironment for every run.
  test("non-git run cwd → LocalEnvironment rooted at the run's cwd", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "swarm-prov-nogit-"));
    try {
      const p = new WorktreeProvisioner();
      const env = await p.ensure("r1", { cwd: nonGit });
      expect(env).toBeInstanceOf(LocalEnvironment);
      expect(env.cwd()).toBe(nonGit);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  test("two non-git runs from different cwds → distinct envs at their own cwds", async () => {
    const a = mkdtempSync(join(tmpdir(), "swarm-prov-a-"));
    const b = mkdtempSync(join(tmpdir(), "swarm-prov-b-"));
    try {
      const p = new WorktreeProvisioner();
      const envA = await p.ensure("r-a", { cwd: a });
      const envB = await p.ensure("r-b", { cwd: b });
      expect(envA).not.toBe(envB);
      expect(envA.cwd()).toBe(a);
      expect(envB.cwd()).toBe(b);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("git run cwd → WorktreeEnvironment under that cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "swarm-prov-git-"));
    try {
      const initRes = Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: repo });
      if (initRes.exitCode !== 0) throw new Error(`git init failed (exit ${initRes.exitCode})`);
      // git worktree add needs a commit to anchor against.
      Bun.spawnSync({
        cmd: ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"],
        cwd: repo,
      });

      const p = new WorktreeProvisioner();
      const env = await p.ensure("r-git", { cwd: repo });
      expect(env).toBeInstanceOf(WorktreeEnvironment);
      expect(env.cwd().startsWith(repo)).toBe(true);
      expect(env.cwd()).toContain(".swarm/worktrees/r-git");

      // Clean up the worktree (registers + removes) so the temp dir is removable.
      await p.dispose("r-git");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("daemon-startup pwd is irrelevant — non-git constructor default doesn't leak into a git run", async () => {
    // Simulate a daemon launched from a non-git dir (this.repoRoot is non-git)
    // but serving a run whose cwd IS a git repo. The provisioner must pick
    // the git path based on the run's cwd, not the constructor default.
    const nonGitRoot = mkdtempSync(join(tmpdir(), "swarm-prov-bootcwd-"));
    const gitRoot = mkdtempSync(join(tmpdir(), "swarm-prov-runcwd-"));
    try {
      const initRes = Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: gitRoot });
      if (initRes.exitCode !== 0) throw new Error(`git init failed (exit ${initRes.exitCode})`);
      Bun.spawnSync({
        cmd: ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"],
        cwd: gitRoot,
      });

      const p = new WorktreeProvisioner({ repoRoot: nonGitRoot });
      const env = await p.ensure("r-mixed", { cwd: gitRoot });
      expect(env).toBeInstanceOf(WorktreeEnvironment);
      expect(env.cwd().startsWith(gitRoot)).toBe(true);
      await p.dispose("r-mixed");
    } finally {
      rmSync(nonGitRoot, { recursive: true, force: true });
      rmSync(gitRoot, { recursive: true, force: true });
    }
  });
});
