// Retry counter reset on success — attractor §3.5.
//
// The per-node `internal.retry_count.<nodeId>` counter must be zeroed when
// a node completes with outcomeStatus="success". Without
// the reset, the count survives a goal-gate retarget (§3.4) and a node that
// retried once in pass 1 would start pass 2 with retry_count=1 — exhausting
// max_retries one step earlier than authors expect.

import { describe, expect, test } from "bun:test";
import { retryCountKey } from "@swarm/core";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

const TERMINAL = new Set(["completed", "cancelled", "halted", "quarantined"]);

async function driveUntilTerminal(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    let state = r.store.getState(runId);
    if (state == null || TERMINAL.has(state.status)) return;
    if (state.status === "paused_auto") {
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
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });
  }
  throw new Error(`run ${runId} did not reach terminal within 100 cycles`);
}

describe("executor — retry counter reset on success (§3.5)", () => {
  test("retry then success clears internal.retry_count.<node>", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 3}\n`;
    const r = rig({ yaml });
    let attempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        attempts++;
        return {
          kind: "transition",
          outcomeStatus: attempts < 2 ? "retry" : "success",
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

    enqueue(r, "rr1", "start");
    await driveUntilTerminal(r, "rr1");

    const state = r.store.getState("rr1")!;
    expect(state.status).toBe("completed");
    // Counter must be 0 after the successful completion (not 1 from the retry).
    expect(state.routing[retryCountKey("work")]).toBe(0);
    r.store.close();
  });

  test("goal-gate retarget re-enters node with retry_count=0 (no carryover from prior pass)", async () => {
    // Graph: start → work → gate → done
    //        gate (goal_gate=true, retry_target=work) fails once then succeeds.
    //        work (max_retries=2) retries once then succeeds in each pass.
    //
    // Without the fix, pass 2 of work starts with retry_count=1 (from pass 1's
    // retry), leaving only one retry budget instead of two — and the run would
    // still complete here, but a node with max_retries=1 would be exhausted.
    // We assert the counter is 0 after the final success and that only one
    // node.retry_scheduled event appears per pass (two total, not three+).
    const yaml = `name: t
steps:
  work: {type: llm, prompt: x, max_retries: 2}
  gate: {type: llm, prompt: g, retry: work}
`;
    const r = rig({ yaml });
    let workAttempts = 0;
    let gateAttempts = 0;

    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        workAttempts++;
        // Retry once per "pass" (passes: 1–2 first pass, 3–4 second pass).
        // Attempt 1 → retry, attempt 2 → success (pass 1).
        // Attempt 3 → retry, attempt 4 → success (pass 2 after retarget).
        const isFirstOfPass = workAttempts % 2 === 1;
        return {
          kind: "transition",
          outcomeStatus: isFirstOfPass ? "retry" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        gateAttempts++;
        return {
          kind: "transition",
          outcomeStatus: gateAttempts === 1 ? "fail" : "success",
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

    enqueue(r, "rr2", "start");
    await driveUntilTerminal(r, "rr2");

    const state = r.store.getState("rr2")!;
    expect(state.status).toBe("completed");

    // work ran 4 times: retry, success, retry, success (two passes × two attempts).
    expect(workAttempts).toBe(4);
    // gate ran twice: fail (triggers retarget), success.
    expect(gateAttempts).toBe(2);

    // Final counter is 0: the last successful pass cleared it.
    expect(state.routing[retryCountKey("work")]).toBe(0);

    // Two retry_scheduled events — one per pass. If the counter carried over,
    // the second pass would still work here (max_retries=2 gives headroom),
    // but we confirm exactly two scheduled events to verify the reset path.
    const events = r.store.getEvents("rr2");
    const retryScheduled = events.filter((e) => e.type === "node.retry_scheduled");
    expect(retryScheduled.length).toBe(2);

    // No exhaustion event — the counter reset ensured both passes had budget.
    const exhausted = events.filter((e) => e.type === "node.retry_exhausted");
    expect(exhausted.length).toBe(0);

    r.store.close();
  });
});
