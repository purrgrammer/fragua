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
    projectCwd: () => cwd,
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
  disposeCalls: Array<{ runId: string; status?: string }> = [];
  private readonly envs = new Map<string, ExecutionEnvironment>();
  constructor(
    private readonly make: (runId: string) => ExecutionEnvironment,
    private readonly opts: { branchOnDispose?: string; baseGitSha?: string } = {},
  ) {}
  async ensure(runId: string): Promise<ExecutionEnvironment> {
    this.ensureCalls.push(runId);
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const env = this.make(runId);
    this.envs.set(runId, env);
    return env;
  }
  async dispose(runId: string, ctx?: { status: string }): Promise<{ branch: string | null }> {
    this.disposeCalls.push({ runId, ...(ctx?.status != null ? { status: ctx.status } : {}) });
    this.envs.delete(runId);
    return { branch: this.opts.branchOnDispose ?? null };
  }
  envFor(runId: string): ExecutionEnvironment | undefined {
    return this.envs.get(runId);
  }
  baseGitSha(_runId: string): string | null {
    return this.opts.baseGitSha ?? null;
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
    expect(provisioner.disposeCalls).toEqual([{ runId: "run-1", status: "completed" }]);

    r.store.close();
  });

  test("baseGitSha from the provisioner is stamped on fact.run_started + run_state", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-sha", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), {
      baseGitSha: "deadbeef0123456789abcdef0123456789abcdef",
    });
    const ctrl = new AbortController();
    await runOne("run-sha", {
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

    const events = r.store.getEvents("run-sha");
    const started = events.find((e) => e.type === "fact.run_started");
    expect(started).toBeDefined();
    const payload = started!.payload as { baseGitSha?: string };
    expect(payload.baseGitSha).toBe("deadbeef0123456789abcdef0123456789abcdef");

    const state = r.store.getState("run-sha");
    expect(state?.baseGitSha).toBe("deadbeef0123456789abcdef0123456789abcdef");

    r.store.close();
  });

  test("dispose returning a branch emits fact.run_branched and updates run_state.branch", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-br", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), {
      branchOnDispose: "swarm/runs/run-br",
    });
    const ctrl = new AbortController();
    await runOne("run-br", {
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

    const events = r.store.getEvents("run-br");
    const branched = events.find((e) => e.type === "fact.run_branched");
    expect(branched).toBeDefined();
    expect((branched!.payload as { branch: string }).branch).toBe("swarm/runs/run-br");

    const state = r.store.getState("run-br");
    expect(state?.branch).toBe("swarm/runs/run-br");
    // Status remains terminal — the branch fact is post-terminal metadata.
    expect(state?.status).toBe("completed");

    r.store.close();
  });

  test("dispose returning null branch emits no fact.run_branched", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-clean", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`));
    const ctrl = new AbortController();
    await runOne("run-clean", {
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

    const events = r.store.getEvents("run-clean");
    expect(events.find((e) => e.type === "fact.run_branched")).toBeUndefined();
    expect(r.store.getState("run-clean")?.branch).toBeNull();

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
      async dispose() {
        return { branch: null };
      },
      envFor() {
        return undefined;
      },
      baseGitSha() {
        return null;
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

    // Provisioning failure also lands a daemon.worktree_provisioned
    // event with ok=false and the underlying error detail.
    const provisioned = r.store.getDaemonEvents().find((e) => e.type === "daemon.worktree_provisioned");
    expect(provisioned).toBeDefined();
    const provPayload = provisioned!.payload as { runId: string; ok: boolean; errorDetail?: string };
    expect(provPayload.runId).toBe("run-fail");
    expect(provPayload.ok).toBe(false);
    expect(provPayload.errorDetail).toContain("no disk space");

    r.store.close();
  });

  test("dispose does not fire on paused_hitl — run can resume with the same env", async () => {
    const r = rig();
    // Register a wait.human spec manually so the first dispatch pauses
    // the run — rig()'s auto-echo only covers trivial transitions.
    r.dispatcher.register(
      r.workflowSha,
      "start",
      handler.makeWaitHumanHandler({ options: [{ key: "O", label: "OK", to: "__end__" }] }),
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
