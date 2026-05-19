// Retry-policy integration tests — attractor §3.5 / §3.6 wired through
// the executor with wake-pending. Each retry now releases the run's
// concurrency slot during the backoff window; wakePending re-queues
// the run when `resumeAt` has elapsed. The test helper below drives
// the wake+claim+runOne loop locally to simulate runExecutor's flow.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

/** Drive the run to a terminal state, looping wake-pending + claim +
 * runOne. wakePending is fed a clock that skips far past any pending
 * retry-resume timestamps, so even the patient preset's 18s delays
 * resolve immediately in tests. */
async function driveUntilTerminal(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  const TERMINAL = new Set(["completed", "cancelled", "halted", "quarantined"]);
  for (let i = 0; i < 100; i++) {
    let state = r.store.getState(runId);
    if (state == null) return;
    if (TERMINAL.has(state.status)) return;
    if (state.status === "paused_auto") {
      // Skip past any pending resumeAt — tests use small delays anyway.
      wakePending(r.store, () => Date.now() + 60_000);
      state = r.store.getState(runId)!;
    }
    if (state.status === "queued") {
      r.store.claimNextRun(1);
    }
    state = r.store.getState(runId)!;
    if (TERMINAL.has(state.status)) return;
    await runOne(runId, {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
  }
  throw new Error(`run ${runId} did not reach terminal within 100 cycles`);
}

describe("executor — retry-policy enforcement", () => {
  test("retry status under budget → re-dispatched and eventually succeeds", async () => {
    const yaml = `name: t\nsteps:\n  flaky: {type: llm, prompt: x, max_retries: 3, retry_policy: none}\n`;
    const r = rig({ yaml });
    let attempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "flaky", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "flaky", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        attempts++;
        return {
          kind: "transition",
          outcomeStatus: attempts < 3 ? "retry" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp1", "start");
    await driveUntilTerminal(r, "rp1");

    const state = r.store.getState("rp1")!;
    expect(state.status).toBe("completed");
    expect(attempts).toBe(3); // 1 initial + 2 retries before success

    const events = r.store.getEvents("rp1");
    const scheduled = events.filter((e) => e.type === "node.retry_scheduled");
    expect(scheduled.length).toBe(2); // two retries scheduled
    r.store.close();
  });

  test("max_retries=0 + retry status → fact.run_paused{reason:'max_retries'} immediately", async () => {
    // Stage 3 of recoverable-budget-pause.md: max_retries_exceeded
    // is now an operator-resumable pause, not a terminal halt.
    // Operator may know the underlying cause is fixed and resume
    // (one more attempt) or raise the cap via
    // intent.max_retries_adjusted.
    const yaml = `name: t\nsteps:\n  flaky: {type: llm, prompt: x, max_retries: 0}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "flaky", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "flaky", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "retry",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp2", "start");
    // driveUntilTerminal would loop forever now (paused isn't terminal),
    // so drive runOne directly until we see the pause.
    r.store.claimNextRun(1);
    await runOne("rp2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp2")!;
    expect(state.status).toBe("paused");
    const pause = r.store
      .getEvents("rp2")
      .filter((e) => e.type === "fact.run_paused")
      .pop();
    expect((pause?.payload as { reason: string }).reason).toBe("max_retries");
    expect((pause?.payload as { nodeId: string }).nodeId).toBe("flaky");
    expect((pause?.payload as { currentLimit: number }).currentLimit).toBe(0);
    r.store.close();
  });

  test("paused_auto (handler_retry) releases the concurrency slot — claimNextRun count excludes it", async () => {
    // The whole point of the wake-pending move: a run sleeping during
    // backoff doesn't hold a `status='running'` slot. claimNextRun
    // counts running runs, so other queued runs can claim while this
    // one waits for resumeAt.
    const yaml = `name: t\nsteps:\n  flaky: {type: llm, prompt: x, max_retries: 3, retry_policy: standard}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "flaky", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "flaky", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "retry",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp4", "start");
    r.store.claimNextRun(1);
    await runOne("rp4", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp4")!;
    expect(state.status).toBe("paused_auto");
    // The slot is free — claimNextRun's `WHERE status = 'running'` count
    // excludes paused_auto runs. With this test's single run sleeping,
    // the count is 0 not 1; another queued run could claim immediately.
    const counts = r.store.runStateCounts();
    expect(counts.running).toBe(0);
    r.store.close();
  });

  test("allow_partial=true on exhaustion → advance with PARTIAL_SUCCESS", async () => {
    const yaml = `name: t\nsteps:\n  flaky: {type: llm, prompt: x, max_retries: 0, allow_partial: true}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "flaky", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "flaky", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "retry",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp3", "start");
    await driveUntilTerminal(r, "rp3");

    const state = r.store.getState("rp3")!;
    expect(state.status).toBe("completed");
    const events = r.store.getEvents("rp3");
    const accept = events.find((e) => e.type === "node.retry_partial_accept");
    expect(accept).toBeDefined();
    // The flaky node's node_completed payload reports outcome=success
    // (advance_partial rewrites the status to success under the simplified model).
    const completed = events
      .filter((e) => e.type === "fact.node_completed")
      .find((e) => (e.payload as { nodeId: string }).nodeId === "flaky");
    expect((completed?.payload as { outcomeStatus?: string }).outcomeStatus).toBe("success");
    r.store.close();
  });
});
