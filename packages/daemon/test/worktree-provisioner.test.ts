// WorktreeProvisioner — lifecycle invariants.
//
// Real `git worktree add` isn't exercised here (that's a workspace-
// layer concern covered by worktree-env.test.ts). This file uses the
// `factory` injection point so lifecycle semantics can be tested in
// isolation without spawning git subprocesses:
//
//   1. `ensure(runId)` is idempotent — repeat calls return the same
//      cached env without re-invoking the factory.
//   2. Concurrent `ensure` calls for the same runId dedupe to a single
//      factory invocation (no double-provisioning).
//   3. `ensure` failures don't poison the cache — a retry calls the
//      factory again.
//   4. `dispose` evicts the cache so a subsequent `ensure` reprovisions.
//   5. `envFor` surfaces the cached env synchronously without provisioning.
//   6. `dispose` on an unknown runId is a no-op (idempotent across
//      lifecycle ordering).
//   7. End-to-end through a real `WorktreeProvisioner` with a git repo
//      is covered by a dedicated slow test guarded behind whether the
//      test host has a git CLI.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@swarm/core";
import { LocalEnvironmentProvisioner, WorktreeProvisioner } from "../src/worktree-provisioner.ts";

function stubEnv(cwd: string): ExecutionEnvironment {
  return {
    cwd: () => cwd,
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

describe("LocalEnvironmentProvisioner — fallback", () => {
  test("ensure returns the same shared LocalEnvironment for every run", async () => {
    const p = new LocalEnvironmentProvisioner(process.cwd());
    const a = await p.ensure("r1");
    const b = await p.ensure("r2");
    expect(a).toBe(b);
    expect(a.cwd()).toBe(process.cwd());
  });

  test("dispose is a no-op (shared env survives)", async () => {
    const p = new LocalEnvironmentProvisioner(process.cwd());
    const a = await p.ensure("r1");
    await p.dispose("r1");
    const b = await p.ensure("r1");
    expect(a).toBe(b);
  });
});
