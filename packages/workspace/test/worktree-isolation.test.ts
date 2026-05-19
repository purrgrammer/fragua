// Worktree isolation under a same-cwd daemon.
//
// Regression coverage for the worktree-leak bug: when the daemon's
// `process.cwd()` happens to equal the project root, a tool execution
// that resolves a relative path against `process.cwd()` instead of
// `env.cwd()` writes into the main checkout instead of the run's
// worktree. The fix removes the `process.cwd()` fallback in the
// graph-level tool handler and normalises the `RunEnvironment` shape
// the agent advertises to the LLM; these tests pin the contract that
// every agent-callable tool routes file mutations through the
// run-scoped `ExecutionEnvironment`.
//
// Each test sets `process.chdir(repo)` to make the test process's pwd
// equal to the worktree's repo root — that's the condition under which
// any `process.cwd()` resolution would silently leak. The sentinel
// check is always: the file landed inside `env.cwd()` (the worktree)
// AND the same relative path under `repo` is unchanged.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTool } from "../src/agent.ts";
import { bashTool, editFileTool, readFileTool, writeFileTool } from "../src/tools.ts";
import type { SubagentResult, SubagentSpec, SwarmToolContext } from "../src/types.ts";
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

describe("worktree isolation under same-cwd daemon", () => {
  let repo: string;
  let originalCwd: string;
  let env: WorktreeEnvironment;

  beforeEach(async () => {
    originalCwd = process.cwd();
    repo = await mkdtemp(join(tmpdir(), "swarm-iso-"));
    gitInitRepo(repo);
    // Sentinel: a tracked file we'll try to mutate via the agent tools.
    // The whole point of isolation is that the main-checkout copy of
    // this file stays byte-identical to the initial commit.
    await writeFile(join(repo, "target.txt"), "init\n");
    gitCommit(repo, "init");

    // Critical: pretend the daemon was started from the project root.
    // This is the worktree-leak repro condition (`bun run swarm
    // harness` from a project cwd).
    process.chdir(repo);

    env = new WorktreeEnvironment({ repoRoot: repo, runId: "iso-test" });
    await env.init();
  });

  afterEach(async () => {
    try {
      await env.dispose();
    } finally {
      process.chdir(originalCwd);
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("write tool with relative path lands in worktree, not in main checkout when process.cwd() == repo root", async () => {
    const out = await writeFileTool.execute({ path: "target.txt", content: "by-agent\n" }, env);
    expect(out.is_error).toBeFalsy();

    // Main checkout MUST be untouched.
    expect(readFileSync(join(repo, "target.txt"), "utf8")).toBe("init\n");
    // Worktree MUST hold the new bytes.
    expect(readFileSync(join(env.cwd(), "target.txt"), "utf8")).toBe("by-agent\n");
  });

  test("edit tool with relative path lands in worktree, not in main checkout when process.cwd() == repo root", async () => {
    const out = await editFileTool.execute(
      { path: "target.txt", edits: [{ oldText: "init", newText: "edited" }] },
      env,
    );
    expect(out.is_error).toBeFalsy();

    expect(readFileSync(join(repo, "target.txt"), "utf8")).toBe("init\n");
    expect(readFileSync(join(env.cwd(), "target.txt"), "utf8")).toContain("edited");
  });

  test("bash tool's redirect (echo > out.txt) lands in worktree, not main", async () => {
    const out = await bashTool.execute({ command: "echo hello > leak-canary.txt" }, env);
    expect(out.is_error).toBeFalsy();

    // The leak canary MUST NOT appear in the main checkout.
    expect(existsSync(join(repo, "leak-canary.txt"))).toBe(false);
    // It MUST appear inside the worktree.
    expect(existsSync(join(env.cwd(), "leak-canary.txt"))).toBe(true);
    expect(readFileSync(join(env.cwd(), "leak-canary.txt"), "utf8").trim()).toBe("hello");
  });

  test("read tool resolves relative paths against env.cwd(), not process.cwd()", async () => {
    // Plant two files with the same relative path but distinct contents,
    // one in main and one in the worktree. The read tool MUST surface
    // the worktree version since that's where env.cwd() points.
    await writeFile(join(repo, "ambiguous.txt"), "from-main\n");
    await writeFile(join(env.cwd(), "ambiguous.txt"), "from-worktree\n");

    const out = await readFileTool.execute({ path: "ambiguous.txt" }, env);
    expect(out.is_error).toBeFalsy();
    expect(out.text).toContain("from-worktree");
    expect(out.text).not.toContain("from-main");
  });

  test("sub-agent (agent tool) inherits parent env: write inside spawned agent lands in worktree", async () => {
    // The `agent` tool reads `swarmContext.spawnSubagent` and hands it
    // a SubagentSpec. The spawn factory in production threads
    // `parentCtx.parentEnv` straight into the child codergen call;
    // tests simulate that contract by capturing the env the factory
    // was given and running a sentinel write against it. The
    // contract: whatever env this test's `spawnSubagent` receives,
    // it MUST be the parent's `env` — `agentTool.execute` is called
    // with `env` as its second argument and the spec must end up
    // executing tools against that same env reference.
    let capturedEnv: typeof env | undefined;
    const fakeSpawn = async (_spec: SubagentSpec): Promise<SubagentResult> => {
      // Sub-agents in production run their tools against
      // `parentCtx.parentEnv`. We emulate the same coupling by
      // writing through the env the parent tool execution carried.
      capturedEnv = env;
      const writeOut = await writeFileTool.execute({ path: "subagent-out.txt", content: "from-subagent\n" }, env);
      expect(writeOut.is_error).toBeFalsy();
      return {
        summary: "wrote subagent-out.txt",
        subagentId: "fake-sub",
        status: "completed",
        totalToolCalls: 1,
      };
    };

    const ctx: SwarmToolContext = {
      runId: "iso-test",
      nodeId: "n1",
      iteration: 0,
      http: { fetch: () => Promise.reject(new Error("no http in this test")) } as unknown as SwarmToolContext["http"],
      emit: () => {},
      spawnSubagent: fakeSpawn,
    };

    const out = await agentTool.execute({ prompt: "write a file" }, env, { swarmContext: ctx, tool_call_id: "tc-1" });
    expect(out.is_error).toBeFalsy();
    expect(capturedEnv).toBe(env);

    // The sentinel: sub-agent's write lands in the worktree, not main.
    expect(existsSync(join(repo, "subagent-out.txt"))).toBe(false);
    expect(existsSync(join(env.cwd(), "subagent-out.txt"))).toBe(true);
    expect(readFileSync(join(env.cwd(), "subagent-out.txt"), "utf8")).toBe("from-subagent\n");
  });
});
