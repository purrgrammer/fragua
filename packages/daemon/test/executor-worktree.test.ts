// Executor ↔ Provisioner lifecycle integration.
//
// Uses a stub provisioner (factory-based) to observe the exact
// sequence of ensure / dispose calls the executor makes. The real
// WorktreeEnvironment is exercised separately in
// packages/workspace/test/worktree-env.test.ts — here we only care
// about the executor's contract with the provisioner interface.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import type { Provisioner } from "../src/worktree-provisioner.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

function stubEnv(cwd: string, extras: Record<string, unknown> = {}): ExecutionEnvironment {
  const base: ExecutionEnvironment = {
    cwd: () => cwd,
    readFile: async () => "",
    writeFile: async () => {},
    exists: async () => false,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    listDir: async () => [],
    glob: async () => [],
  };
  return Object.assign(base, extras);
}

class RecordingProvisioner implements Provisioner {
  ensureCalls: string[] = [];
  disposeCalls: string[] = [];
  private readonly envs = new Map<string, ExecutionEnvironment>();
  constructor(private readonly make: (runId: string) => ExecutionEnvironment) {}
  async ensure(runId: string): Promise<ExecutionEnvironment> {
    this.ensureCalls.push(runId);
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const env = this.make(runId);
    this.envs.set(runId, env);
    return env;
  }
  async dispose(runId: string): Promise<void> {
    this.disposeCalls.push(runId);
    this.envs.delete(runId);
  }
  envFor(runId: string): ExecutionEnvironment | undefined {
    return this.envs.get(runId);
  }
}

describe("executor + worktree provisioner", () => {
  test("ensure fires once before the first node and dispose fires on terminal status", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-1", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`));
    const ctrl = new AbortController();
    await runOne("run-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 4,
      shutdownSignal: ctrl.signal,
      maxTurnsForTesting: 20,
      provisioner,
    });

    expect(provisioner.ensureCalls).toEqual(["run-1"]); // only once, even across multiple turns
    expect(provisioner.disposeCalls).toEqual(["run-1"]);

    r.store.close();
  });

  test("ensure failure halts the run with worktree_provision_failed detail", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-fail", "start");
    r.store.claimNextRun(4);

    const provisioner: Provisioner = {
      async ensure() {
        throw new Error("no disk space");
      },
      async dispose() {},
      envFor() {
        return undefined;
      },
    };
    const ctrl = new AbortController();
    await runOne("run-fail", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 4,
      shutdownSignal: ctrl.signal,
      maxTurnsForTesting: 5,
      provisioner,
    });

    const state = r.store.getState("run-fail");
    expect(state?.status).toBe("halted");
    const events = r.store.getEvents("run-fail");
    const halt = events.find((e) => e.type === "fact.run_halted");
    expect(halt).toBeDefined();
    const payload = halt!.payload as { reason: string; detail?: string };
    expect(payload.reason).toBe("error");
    expect(payload.detail).toContain("worktree_provision_failed");
    expect(payload.detail).toContain("no disk space");

    r.store.close();
  });

  test("dispose does not fire on paused_hitl — run can resume with the same env", async () => {
    const r = rig();
    // Register a wait.human spec manually so the first dispatch pauses
    // the run — rig()'s auto-echo only covers trivial transitions.
    r.dispatcher.register(
      r.workflowSha,
      "start",
      handler.makeWaitHumanHandler({ prompt: "hold", nextNode: "__end__" }),
    );
    enqueue(r, "run-paused", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`));
    const ctrl = new AbortController();
    await runOne("run-paused", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 4,
      shutdownSignal: ctrl.signal,
      maxTurnsForTesting: 10,
      provisioner,
    });
    expect(r.store.getState("run-paused")?.status).toBe("paused_hitl");
    expect(provisioner.ensureCalls).toEqual(["run-paused"]);
    expect(provisioner.disposeCalls).toEqual([]); // NOT disposed on pause

    // Env cached — a resume would reuse it.
    expect(provisioner.envFor("run-paused")?.cwd()).toBe("/fake/run-paused");

    r.store.close();
  });
});
