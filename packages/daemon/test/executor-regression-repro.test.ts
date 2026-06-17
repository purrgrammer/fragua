import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, type ExecutionEnvironment, parseWorkflow, serializeGraph } from "@fragua/core";
import { applyFact, ConcurrencyError, type FactEvent, type RunState } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runExecutor, runOne } from "../src/executor.ts";
import type { SnapshotResult } from "../src/snapshotter.ts";
import { wakePending } from "../src/wake-pending.ts";
import type { Provisioner } from "../src/worktree-provisioner.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

/** Drive a run to a terminal state across auto-resume pauses (the
 * handler_retry / provider_retry / timeout_retry boundaries that release
 * the slot and wait for wake-pending). Each runOne settles at the next
 * pause; wakePending re-queues the run once its backoff has elapsed. */
async function driveToTerminal(r: ReturnType<typeof rig>, runId: string, maxRounds = 20): Promise<void> {
  const terminal = new Set(["completed", "halted", "cancelled", "paused", "paused_human", "quarantined"]);
  for (let round = 0; round < maxRounds; round++) {
    wakePending(r.store);
    const claimed = r.store.claimNextRun(1);
    if (claimed == null) {
      const status = r.store.getState(runId)?.status;
      if (status != null && terminal.has(status)) return;
      await new Promise((res) => setTimeout(res, 5));
      continue;
    }
    await runOne(claimed.runId, runOpts(r));
  }
}

function runOpts(
  r: ReturnType<typeof rig>,
  extra: Partial<Parameters<typeof runOne>[1]> = {},
): Parameters<typeof runOne>[1] {
  return {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 20,
    shutdownSignal: new AbortController().signal,
    ...extra,
  };
}

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

class SnapshotProvisioner implements Provisioner {
  readonly disposeCalls: string[] = [];
  readonly snapshotCalls: string[] = [];
  private readonly envs = new Map<string, ExecutionEnvironment>();

  constructor(private readonly snapshotResult: SnapshotResult | null) {}

  async ensure(runId: string): Promise<ExecutionEnvironment> {
    const cached = this.envs.get(runId);
    if (cached) return cached;
    const env = stubEnv(`/fake/${runId}`);
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

  baseGitSha(_runId: string): string | null {
    return "base";
  }

  baseGitRef(_runId: string): string | null {
    return null;
  }

  async snapshot(_runId: string, boundary: string): Promise<SnapshotResult | null> {
    this.snapshotCalls.push(boundary);
    return this.snapshotResult;
  }
}

/**
 * Wrap `store.appendFact` so matching commits raise a `ConcurrencyError`,
 * modelling an OCC conflict from a concurrent writer.
 *
 * `opts.times` bounds how many matching appends conflict before the wrap
 * passes through (default: every matching append). A transient (finite)
 * conflict models the realistic case — a racing writer advanced the
 * version, the retry against fresh state then lands — so a test can assert
 * the run reaches its intended terminal state after the executor retries.
 */
function failAppendWhen(
  store: ReturnType<typeof rig>["store"],
  predicate: (facts: readonly FactEvent[]) => boolean,
  opts: { times?: number } = {},
): { restore: () => void } {
  const original = store.appendFact.bind(store);
  const limit = opts.times ?? Number.POSITIVE_INFINITY;
  let conflicts = 0;
  store.appendFact = ((runId, facts, expectedVersion, appendOpts) => {
    if (predicate(facts) && conflicts < limit) {
      conflicts++;
      throw new ConcurrencyError(expectedVersion, expectedVersion + 1);
    }
    return original(runId, facts, expectedVersion, appendOpts);
  }) as typeof store.appendFact;
  return {
    restore: () => {
      store.appendFact = original;
    },
  };
}

describe("executor regression repros", () => {
  test("per-node retry iteration is used for node_completed, messages, and artifacts", async () => {
    const r = rig({
      yaml: `name: t
steps:
  work:
    type: llm
    prompt: x
    max_retries: 2
    on: {retry: work, success: done}
  done: {type: exit}
`,
    });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    let calls = 0;
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async (ctx) => {
        ctx.messages.append({
          role: "user",
          content: [{ type: "text", text: `iteration ${ctx.iteration}` }],
          timestamp: ctx.iteration,
        });
        ctx.artifacts.put("same-key", `value-${ctx.iteration}`);
        calls++;
        return {
          kind: "transition",
          outcomeStatus: calls === 1 ? "retry" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    registerTerminalEcho(r.dispatcher, r.workflowSha, "done");

    enqueue(r, "iter-repro", "start");
    // The retry pauses the run (handler_retry → paused_auto); the second
    // iteration only happens after wake-pending re-queues it. Drive across
    // the pause so both iterations land.
    await driveToTerminal(r, "iter-repro");

    const workCompleted = r.store
      .getEvents("iter-repro")
      .filter((e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "work");
    expect(workCompleted.map((e) => (e.payload as { iteration: number }).iteration)).toEqual([0, 1]);
    expect(
      r.store.getMessages("iter-repro", { nodeId: "work", limit: Number.MAX_SAFE_INTEGER }).map((m) => m.iteration),
    ).toEqual([0, 1]);
    expect(
      r.store.getArtifactRef({ runId: "iter-repro", nodeId: "work", iteration: 0, key: "same-key" }),
    ).not.toBeNull();
    expect(
      r.store.getArtifactRef({ runId: "iter-repro", nodeId: "work", iteration: 1, key: "same-key" }),
    ).not.toBeNull();
  });

  test("cancel commit OCC conflict does not get silently treated as terminal", async () => {
    const r = rig();
    enqueue(r, "cancel-occ", "start");
    r.store.claimNextRun(1);
    r.store.appendIntent("cancel-occ", { type: "intent.cancel_requested", payload: {} });

    // One transient OCC conflict on the cancel commit (a concurrent
    // writer advanced the version). The executor must retry against fresh
    // state rather than swallow the conflict and leave the run `running`.
    const { restore } = failAppendWhen(
      r.store,
      (facts) =>
        facts.some((f) => f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "aborted"),
      {
        times: 1,
      },
    );
    try {
      await runOne("cancel-occ", runOpts(r));
    } finally {
      restore();
    }

    expect(r.store.getState("cancel-occ")?.status).toBe("cancelled");
    expect(
      r.store
        .getEvents("cancel-occ")
        .some((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "aborted"),
    ).toBe(true);
  });

  test("terminal snapshot OCC conflict retains worktree instead of disposing without fact.snapshot_recorded", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "snapshot-occ", "start");
    r.store.claimNextRun(1);

    const provisioner = new SnapshotProvisioner({
      treeSha: "tree",
      commitSha: "snap",
      parentSnap: "parent",
      headSha: "head",
      headRef: null,
      diffBaseSha: "base",
      committed: null,
      uncommitted: { filesChanged: 1, insertions: 1, deletions: 0 },
    });
    const { restore } = failAppendWhen(r.store, (facts) => facts.some((f) => f.type === "fact.snapshot_recorded"));
    try {
      await runOne("snapshot-occ", runOpts(r, { provisioner }));
    } finally {
      restore();
    }

    expect(provisioner.snapshotCalls).toContain("terminal");
    expect(r.store.getEvents("snapshot-occ").some((e) => e.type === "fact.snapshot_recorded")).toBe(false);
    expect(provisioner.disposeCalls).toEqual([]);
  });

  test("bounded handler clears its leak-watchdog timer after normal completion", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "timer-repro", "start");
    r.store.claimNextRun(1);

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const active = new Set<unknown>();
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const token = { handler, timeout, args };
      active.add(token);
      return token as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((token: unknown) => {
      active.delete(token);
    }) as typeof clearTimeout;
    try {
      await runOne("timer-repro", runOpts(r));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    expect(active.size).toBe(0);
  });

  test("fact.run_requeued_after_crash requeues and clears currentNode for a clean re-claim", () => {
    const r = rig();
    enqueue(r, "replay-crash", "start");
    r.store.claimNextRun(1);
    r.store.appendFact(
      "replay-crash",
      [{ type: "fact.run_started", payload: { workflowSha: r.workflowSha, contractVersion: 1, startNode: "work" } }],
      r.store.getState("replay-crash")!.version,
    );
    const live = r.store.getState("replay-crash") as RunState;
    expect(live.currentNode).toBe("work");

    const replayed = applyFact(
      live,
      { type: "fact.run_requeued_after_crash", payload: { prevNode: "work", lastAliveAt: live.updatedAt + 1 } },
      live.updatedAt + 2,
    );

    // A crash-requeue puts the run back to `queued` and clears currentNode
    // (and dispatchStartedAt): the next claim re-derives the start node and
    // re-dispatches it fresh. `prevNode` is retained on the fact for
    // analytics/resume provenance, not projected onto currentNode.
    expect(replayed.status).toBe("queued");
    expect(replayed.currentNode).toBeNull();
    expect(replayed.dispatchStartedAt).toBeNull();
  });

  test("maxLoops counts only handler dispatches, not dispatch marker bookkeeping turns", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  middle: {type: llm, prompt: m}\n` });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "middle", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "middle", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "maxloops-marker", "start");
    r.store.claimNextRun(1);
    await runOne("maxloops-marker", runOpts(r, { maxLoops: 2 }));

    expect(r.store.getState("maxloops-marker")?.status).toBe("completed");
    expect(r.store.getEvents("maxloops-marker").some((e) => e.type === "fact.run_paused")).toBe(false);
  });

  test("reactive budget abort reason is classified as budget, not generic handler error", async () => {
    const r = rig({
      yaml: `name: t
budget: 1.0
budget-policy: stop
steps:
  spend: {type: llm, prompt: s}
`,
    });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "spend", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "spend", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async (ctx) => {
        ctx.emit("cost.recorded", {
          total_tokens: 10,
          input_tokens: 5,
          output_tokens: 5,
          cost_usd: 1.5,
          model: "stub",
        });
        if (ctx.signal.aborted) throw ctx.signal.reason;
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });

    enqueue(r, "budget-abort-reason", "start");
    r.store.claimNextRun(1);
    await runOne("budget-abort-reason", runOpts(r));

    const halt = r.store
      .getEvents("budget-abort-reason")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect((halt?.payload as { reason?: string } | undefined)?.reason).toBe("budget");
  });

  test("node_started uses the resolved per-node iteration when entering a retried node", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  work: {type: llm, prompt: x}\n` });
    r.store.enqueueRun({
      runId: "node-started-iteration",
      workflowSha: r.workflowSha,
      initialRouting: { start_node: "start", "internal.retry_count.work": 1 },
    });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });

    r.store.claimNextRun(1);
    await runOne("node-started-iteration", runOpts(r, { maxTurnsForTesting: 4 }));

    const started = r.store
      .getEvents("node-started-iteration")
      .find((e) => e.type === "fact.node_started" && (e.payload as { nodeId: string }).nodeId === "work");
    expect((started?.payload as { iteration?: number } | undefined)?.iteration).toBe(1);
  });

  // NOTE: a regression repro asserting that an explicit `Retry-After`
  // beyond PROVIDER_RETRY_MAX_CUMULATIVE_MS must return `exhausted` was
  // removed here — it contradicted the deliberate, documented design
  // (provider-retry-policy.ts and the committed
  // provider-retry-policy.test.ts "Retry-After bypasses cumulative-delay
  // cap (provider knows best)"): a provider's explicit Retry-After is
  // honoured exactly, and the operator can resume earlier. The cumulative
  // cap bounds computed backoff only.

  test("runExecutor clears shutdown drain timer when in-flight run settles first", async () => {
    const r = rig();
    const shutdown = new AbortController();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      handler: async () => {
        shutdown.abort();
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "drain-timer", "start");

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const active = new Set<unknown>();
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const token = { handler, timeout, args };
      active.add(token);
      return token as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((token: unknown) => {
      active.delete(token);
    }) as typeof clearTimeout;
    try {
      await runExecutor({
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        pollIntervalMs: 1,
        shutdownDrainMs: 30_000,
        shutdownSignal: shutdown.signal,
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    expect(active.size).toBe(0);
  });

  test("budget snapshot reflects operator override limits on the first resumed dispatch", async () => {
    const r = rig({
      yaml: `name: t
budget: 1.0
steps:
  spend: {type: llm, prompt: s}
`,
    });
    let seenRunMax: number | undefined;
    r.store.enqueueRun({
      runId: "budget-snapshot-override",
      workflowSha: r.workflowSha,
      initialRouting: { start_node: "spend", "budget_override.run.cost": 5 },
    });
    r.dispatcher.register(r.workflowSha, "spend", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async (ctx) => {
        seenRunMax = ctx.budgetSnapshot?.run_max_cost_usd;
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });

    r.store.claimNextRun(1);
    await runOne("budget-snapshot-override", runOpts(r));

    expect(seenRunMax).toBe(5);
  });

  test("OCC ceiling does not report terminal when occ_exhausted halt append also conflicts", async () => {
    const r = rig();
    enqueue(r, "occ-halt-conflict", "start");
    r.store.claimNextRun(1);

    // Three run_started conflicts trip the OCC ceiling; the occ_exhausted
    // run_halted append then conflicts once more before landing. The
    // executor must retry the halt (rather than report terminal while the
    // halt fact never committed). Matching-append order is
    // run_started ×3, run_halted (fail), run_halted (lands) — so the first
    // four conflict, the fifth passes.
    const { restore } = failAppendWhen(
      r.store,
      (facts) =>
        facts.some(
          (f) =>
            f.type === "fact.run_started" ||
            (f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "errored"),
        ),
      { times: 4 },
    );
    try {
      await runOne("occ-halt-conflict", runOpts(r, { maxTurnsForTesting: 10 }));
    } finally {
      restore();
    }

    expect(r.store.getState("occ-halt-conflict")?.status).toBe("halted");
    const halt = r.store
      .getEvents("occ-halt-conflict")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect((halt?.payload as { reason?: string } | undefined)?.reason).toBe("occ_exhausted");
  });

  test("unparseable workflow graph halts instead of silently completing through __end__", async () => {
    const r = rig({ yaml: "name: [unterminated\nsteps:\n  start: {type: llm, prompt: x}\n", ir: "not-valid-ir-json" });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "bad-graph", "start");
    r.store.claimNextRun(1);
    await runOne("bad-graph", runOpts(r));

    expect(r.store.getState("bad-graph")?.status).toBe("halted");
    expect(
      r.store
        .getEvents("bad-graph")
        .some((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "completed"),
    ).toBe(false);
  });

  test("workflow_parse_failed halt detail carries the underlying parse error", async () => {
    const r = rig({ ir: "not-valid-ir-json" });
    enqueue(r, "bad-graph-detail", "start");
    r.store.claimNextRun(1);
    await runOne("bad-graph-detail", runOpts(r));

    const halt = r.store
      .getEvents("bad-graph-detail")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    const detail = (halt?.payload as { detail?: string } | undefined)?.detail;
    expect(detail?.startsWith("workflow_parse_failed: ")).toBe(true);
    expect(detail).toMatch(/JSON/i);
  });

  test("workflow_parse_failed halt detail surfaces an unsupported ir_version", async () => {
    const r = rig();
    const source = "name: t\nsteps:\n  start: {type: llm, prompt: hi}\n";
    r.store.saveWorkflow("wf-future", "t", source, serializeGraph(parseWorkflow(source)), CURRENT_IR_VERSION + 1);
    r.store.enqueueRun({
      runId: "future-ir",
      workflowSha: "wf-future",
      priority: 0,
      initialRouting: { start_node: "start" },
    });
    r.store.claimNextRun(1);
    await runOne("future-ir", runOpts(r));

    const halt = r.store
      .getEvents("future-ir")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    const detail = (halt?.payload as { detail?: string } | undefined)?.detail;
    expect(detail?.startsWith("workflow_parse_failed: ")).toBe(true);
    expect(detail).toContain(`ir_version ${CURRENT_IR_VERSION + 1} > supported ${CURRENT_IR_VERSION}`);
  });
});
