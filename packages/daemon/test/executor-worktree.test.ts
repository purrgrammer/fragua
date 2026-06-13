// Executor ↔ Provisioner lifecycle integration.
//
// Uses a stub provisioner (factory-based) to observe the exact
// sequence of ensure / dispose calls the executor makes. The real
// WorktreeEnvironment is exercised separately in
// packages/workspace/test/worktree-env.test.ts — here we only care
// about the executor's contract with the provisioner interface.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import type { SnapshotResult } from "../src/snapshotter.ts";
import type { Provisioner } from "../src/worktree-provisioner.ts";
import { enqueue, registerTerminalEcho, rig, type TestRig } from "./helpers.ts";

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
  disposeCalls: Array<{ runId: string }> = [];
  private readonly envs = new Map<string, ExecutionEnvironment>();
  constructor(
    private readonly make: (runId: string) => ExecutionEnvironment,
    private readonly opts: {
      baseGitSha?: string;
      baseGitRef?: string;
      snapshotResult?: SnapshotResult | null;
    } = {},
  ) {}
  async ensure(runId: string): Promise<ExecutionEnvironment> {
    this.ensureCalls.push(runId);
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const env = this.make(runId);
    this.envs.set(runId, env);
    return env;
  }
  async dispose(runId: string): Promise<void> {
    this.disposeCalls.push({ runId });
    this.envs.delete(runId);
  }
  envFor(runId: string): ExecutionEnvironment | undefined {
    return this.envs.get(runId);
  }
  baseGitSha(_runId: string): string | null {
    return this.opts.baseGitSha ?? null;
  }
  baseGitRef(_runId: string): string | null {
    return this.opts.baseGitRef ?? null;
  }
  snapshotCalls: string[] = [];
  async snapshot(_runId: string, boundary: string): Promise<SnapshotResult | null> {
    this.snapshotCalls.push(boundary);
    return this.opts.snapshotResult ?? null;
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
    // dispose no longer receives a ctx (no dispose-time commit) — just the runId.
    expect(provisioner.disposeCalls).toEqual([{ runId: "run-1" }]);

    r.store.close();
  });

  test("baseGitSha + baseGitRef from the provisioner are stamped on fact.run_started + run_state", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-sha", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), {
      baseGitSha: "deadbeef0123456789abcdef0123456789abcdef",
      baseGitRef: "main",
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
    const payload = started!.payload as { baseGitSha?: string; baseGitRef?: string };
    expect(payload.baseGitSha).toBe("deadbeef0123456789abcdef0123456789abcdef");
    expect(payload.baseGitRef).toBe("main");

    const state = r.store.getState("run-sha");
    expect(state?.baseGitSha).toBe("deadbeef0123456789abcdef0123456789abcdef");
    expect(state?.baseGitRef).toBe("main");

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
      baseGitSha() {
        return null;
      },
      baseGitRef() {
        return null;
      },
      async snapshot() {
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
    expect(payload.reason).toBe("worktree_error");
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

  test("terminal snapshot result → fact.snapshot_recorded + inbox/final projection", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run-snap", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), {
      snapshotResult: {
        treeSha: "tree1",
        commitSha: "commit1",
        parentSnap: "base1",
        headSha: "head1",
        headRef: null,
        diffBaseSha: "base1",
        committed: null,
        uncommitted: { filesChanged: 1, insertions: 2, deletions: 0 },
      },
    });
    const ctrl = new AbortController();
    await runOne("run-snap", {
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

    // The executor captured at the terminal boundary, before dispose.
    expect(provisioner.snapshotCalls).toContain("terminal");

    const events = r.store.getEvents("run-snap");
    const snap = events.find((e) => e.type === "fact.snapshot_recorded");
    expect(snap).toBeDefined();
    expect((snap!.payload as { commitSha: string }).commitSha).toBe("commit1");

    const state = r.store.getState("run-snap");
    expect(state?.finalGitSha).toBe("head1");
    // uncommitted dirt present → recoverable → inbox pending.
    expect(state?.inboxStatus).toBe("pending");
    expect(state?.changeStat?.uncommitted).toEqual({ filesChanged: 1, insertions: 2, deletions: 0 });

    r.store.close();
  });

  test("dispose does not fire on paused_human — run can resume with the same env", async () => {
    const r = rig();
    // Register a wait.human spec manually so the first dispatch pauses
    // the run — rig()'s auto-echo only covers trivial transitions.
    r.dispatcher.register(
      r.workflowSha,
      "start",
      handler.makeHumanHandler({ nodeId: "ask", text: "wait", routes: ["O"], edges: [{ route: "O", to: "__end__" }] }),
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
    expect(r.store.getState("run-paused")?.status).toBe("paused_human");
    expect(provisioner.ensureCalls).toEqual(["run-paused"]);
    expect(provisioner.disposeCalls).toEqual([]); // NOT disposed on pause

    // Env cached — a resume would reuse it.
    expect(provisioner.envFor("run-paused")?.cwd()).toBe("/fake/run-paused");

    r.store.close();
  });

  // Register a two-node graph "start -> work" where `work` is terminal, so
  // `start` produces exactly one NON-terminal node_completed (a per-step
  // boundary) and `work` settles the run (the terminal boundary).
  function registerTwoStep(r: TestRig): void {
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
  }

  test("per-step boundary emits snapshot.captured tagged with the completed node", async () => {
    const r = rig();
    registerTwoStep(r);
    enqueue(r, "run-step", "start");
    r.store.claimNextRun(4);

    const snap: SnapshotResult = {
      treeSha: "tree-s",
      commitSha: "commit-s",
      parentSnap: "base0",
      headSha: "head-s",
    };
    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), { snapshotResult: snap });
    const ctrl = new AbortController();
    await runOne("run-step", {
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

    // start completed non-terminally → "step"; work settled the run → "terminal".
    expect(provisioner.snapshotCalls).toContain("step");
    expect(provisioner.snapshotCalls).toContain("terminal");
    const captured = r.store.getEvents("run-step").filter((e) => e.type === "snapshot.captured");
    expect(captured.length).toBe(1);
    expect((captured[0]!.payload as { nodeId: string | null }).nodeId).toBe("start");
    // The terminal boundary stays a fact, not an observability snapshot.
    expect(r.store.getEvents("run-step").some((e) => e.type === "fact.snapshot_recorded")).toBe(true);

    r.store.close();
  });

  test("a suppressed per-step snapshot (provisioner returns null) emits no snapshot.captured", async () => {
    const r = rig();
    registerTwoStep(r);
    enqueue(r, "run-step-suppressed", "start");
    r.store.claimNextRun(4);

    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), { snapshotResult: null });
    const ctrl = new AbortController();
    await runOne("run-step-suppressed", {
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

    expect(provisioner.snapshotCalls).toContain("step"); // still probed
    expect(r.store.getEvents("run-step-suppressed").filter((e) => e.type === "snapshot.captured").length).toBe(0);

    r.store.close();
  });

  test("a HITL pause emits snapshot.captured with nodeId null", async () => {
    const r = rig();
    r.dispatcher.register(
      r.workflowSha,
      "start",
      handler.makeHumanHandler({ nodeId: "ask", text: "wait", routes: ["O"], edges: [{ route: "O", to: "__end__" }] }),
    );
    enqueue(r, "run-hitl", "start");
    r.store.claimNextRun(4);

    const snap: SnapshotResult = {
      treeSha: "tree-h",
      commitSha: "commit-h",
      parentSnap: "base0",
      headSha: "head-h",
      headRef: null,
      diffBaseSha: "base0",
      committed: null,
      uncommitted: { filesChanged: 1, insertions: 2, deletions: 0 },
    };
    const provisioner = new RecordingProvisioner((id) => stubEnv(`/fake/${id}`), { snapshotResult: snap });
    const ctrl = new AbortController();
    await runOne("run-hitl", {
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

    expect(r.store.getState("run-hitl")?.status).toBe("paused_human");
    expect(provisioner.snapshotCalls).toContain("hitl");
    const captured = r.store.getEvents("run-hitl").filter((e) => e.type === "snapshot.captured");
    expect(captured.length).toBe(1);
    expect((captured[0]!.payload as { nodeId: string | null }).nodeId).toBeNull();

    r.store.close();
  });
});
