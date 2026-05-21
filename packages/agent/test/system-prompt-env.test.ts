// Regression coverage for the `RunEnvironment` rename and the
// `deriveRunEnv` flattening that landed alongside the worktree-isolation
// fix. The interface used to expose `worktreePath: string` (the field
// only existed on `WorktreeEnvironment`, so `deriveRunEnv` returned
// `undefined` for `LocalEnvironment` and the system prompt silently
// omitted the `<environment>` block). Post-fix the field is `cwd` and
// every env yields a block.

import { describe, expect, test } from "bun:test";
import { LocalEnvironment } from "@fragua/workspace";
import { deriveRunEnv } from "../src/backend.ts";
import { renderRunEnvironment } from "../src/system-prompt.ts";

describe("renderRunEnvironment after RunEnvironment.cwd rename", () => {
  test("cwd field is required and surfaces as cwd: <value> in the block", () => {
    const block = renderRunEnvironment({ cwd: "/path/to/worktree", runId: "r1" });
    expect(block).toContain("cwd: /path/to/worktree");
    expect(block).toContain("run_id: r1");
    // Negative-example interpolation still reflects the value.
    expect(block).toContain("❌ cd /path/to/worktree && pwd");
  });

  test("deriveRunEnv populates cwd from env.cwd() for both LocalEnvironment and WorktreeEnvironment", () => {
    // LocalEnvironment used to return `undefined` from deriveRunEnv —
    // the entire <environment> block was suppressed for bare-daemon
    // runs. New contract: every env yields a value.
    const local = new LocalEnvironment({ cwd: "/some/path" });
    const out = deriveRunEnv(local, "run-id");
    expect(out.cwd).toBe("/some/path");
    expect(out.runId).toBe("run-id");
    expect(out.bootstrapCommand).toBeUndefined();
  });

  test("deriveRunEnv picks up env.runId and env.bootstrapCommand structurally when present", () => {
    // Simulate the WorktreeEnvironment-shaped duck-type: cwd() plus
    // own `runId` and `bootstrapCommand` fields. Both are picked up
    // without taking a hard dep on @fragua/workspace here.
    const fakeWorktree = {
      cwd: () => "/wt/abc",
      projectCwd: () => "/repo",
      runId: "abc-own",
      bootstrapCommand: "bun install --frozen-lockfile",
      // Stubbed members; deriveRunEnv shouldn't call them.
      readFile: async () => "",
      writeFile: async () => {},
      exists: async () => false,
      listDir: async () => [],
      glob: async () => [],
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    };
    const out = deriveRunEnv(fakeWorktree, "fallback-run-id");
    expect(out.cwd).toBe("/wt/abc");
    // env-owned runId wins over the fallback the caller passed in.
    expect(out.runId).toBe("abc-own");
    expect(out.bootstrapCommand).toBe("bun install --frozen-lockfile");
  });
});
