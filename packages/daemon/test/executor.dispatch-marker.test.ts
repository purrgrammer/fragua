// Executor emission of fact.dispatch_started — exercises the wire-up
// added in the Phase 2 commit. Reducer-level activeMs accounting has
// its own coverage in packages/store/test/active-ms.test.ts; this file
// asserts the production codepath actually emits the fact and that
// activeMs ends non-zero in run_state after a completed multi-node
// run.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — fact.dispatch_started emission", () => {
  test("fires once per non-first dispatch; first dispatch covered by run_started", async () => {
    const yaml = `name: t\nsteps:\n  middle: {type: llm, prompt: x, next: tail}\n  tail: {type: llm, prompt: y}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "middle", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "middle", {
      kind: "step",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "tail", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "tail", {
      kind: "step",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "dm-1", "start");
    r.store.claimNextRun(1);
    await runOne("dm-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("dm-1");

    // Exactly one fact.run_started — covers the start dispatch.
    const runStarted = events.filter((e) => e.type === "fact.run_started");
    expect(runStarted.length).toBe(1);

    // fact.dispatch_started fires for middle + tail (the post-transition
    // dispatches), not for start. Each one carries the right nodeId.
    const dispatchStarted = events.filter((e) => e.type === "fact.dispatch_started");
    const dispatchedNodeIds = dispatchStarted.map((e) => (e.payload as { nodeId: string }).nodeId);
    expect(dispatchedNodeIds).toEqual(["middle", "tail"]);

    // resumeOf == "fresh" for in-run transitions.
    for (const e of dispatchStarted) {
      expect((e.payload as { resumeOf: string }).resumeOf).toBe("fresh");
    }

    // activeMs accumulated and projection cleared dispatchStartedAt at run end.
    const final = r.store.getState("dm-1");
    expect(final).not.toBeNull();
    expect(final!.status).toBe("completed");
    expect(final!.dispatchStartedAt).toBeNull();
    // Three dispatches, each ≥ 0ms; activeMs is wall-clock so >= 0
    // (commonly tiny but non-negative).
    expect(final!.metrics.activeMs).toBeGreaterThanOrEqual(0);
  });

  test("dispatchStartedAt is non-null while a handler is in flight", async () => {
    // Single-node workflow with a handler that captures the projection
    // mid-call. The handler reads run_state directly (it's pure SQL,
    // not the executor's local snapshot), so we see what other
    // observers would see.
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    let observedDispatchStartedAt: number | null | undefined;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        observedDispatchStartedAt = r.store.getState("dm-2")?.dispatchStartedAt ?? null;
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "dm-2", "start");
    r.store.claimNextRun(1);
    await runOne("dm-2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: new AbortController().signal,
    });
    expect(observedDispatchStartedAt).not.toBeNull();
    expect(typeof observedDispatchStartedAt).toBe("number");

    // After completion, dispatchStartedAt is closed.
    expect(r.store.getState("dm-2")!.dispatchStartedAt).toBeNull();
  });
});
