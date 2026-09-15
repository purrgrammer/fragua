// Pre-claim intents — operator intents appended while a run is `queued`
// (before the executor claims it) must survive the `run_started` turn.
// docs/intent-fold.md lists `queued` as a valid state for budget_adjusted
// and steering_requested; the fold consumes them on the first turn.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { startSupervisor } from "../src/supervisor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — pre-claim intents", () => {
  test("pre-claim intent.budget_adjusted lands in run_state.routing.budget_override.run.cost", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp1", "start");
    r.store.appendIntent("rp1", {
      type: "intent.budget_adjusted",
      payload: { scope: "run", metric: "cost", newLimit: 5.0 },
    });
    r.store.claimNextRun(1);
    await runOne("rp1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp1")!;
    expect(state.routing["budget_override.run.cost"]).toBe(5.0);

    r.store.close();
  });

  test("pre-claim intent.steering_requested reaches the first handler's ctx.steering", async () => {
    const r = rig();
    const seenSteering: Array<string | undefined> = [];
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async (ctx) => {
        seenSteering.push(ctx.steering);
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "rp2", "start");
    r.store.appendIntent("rp2", {
      type: "intent.steering_requested",
      payload: { text: "focus on the auth module" },
    });
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

    expect(seenSteering).toContain("focus on the auth module");

    r.store.close();
  });

  // Regression for the two High defects: a pre-claim steer co-arriving with a
  // higher-seq non-steer intent (budget_adjusted). With the supervisor running
  // and a handler that outlives several ticks, the budget override must apply,
  // the steer must reach ctx.steering exactly once, the handler must not be
  // tripped, and the supervisor must not double-deliver via onSteer.
  test("pre-claim steer + trailing budget_adjusted: budget applies, steer delivered once, no trip, no onSteer", async () => {
    const r = rig();
    const seenSteering: Array<string | undefined> = [];
    let sawAbort = false;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 5_000,
      handler: async (ctx) => {
        seenSteering.push(ctx.steering);
        // Outlive several 5ms supervisor ticks so a spurious trip / onSteer
        // would have a window to fire.
        for (let i = 0; i < 12; i++) {
          if (ctx.signal.aborted) {
            sawAbort = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 10));
        }
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "rp3", "start");
    // steer at seq N, budget at seq N+1 — the co-arrival the watermark can't
    // hold back on the intent log.
    r.store.appendIntent("rp3", {
      type: "intent.steering_requested",
      payload: { text: "focus on the auth module" },
    });
    r.store.appendIntent("rp3", {
      type: "intent.budget_adjusted",
      payload: { scope: "run", metric: "cost", newLimit: 5.0 },
    });
    r.store.claimNextRun(1);

    const registry = new AbortRegistry();
    const onSteerCalls: Array<{ runId: string; text: string }> = [];
    const shutdown = new AbortController();
    const sup = startSupervisor({
      store: r.store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 5,
      heartbeatIntervalMs: 1_000_000,
      onSteer: (runId, text) => onSteerCalls.push({ runId, text }),
    });

    try {
      await runOne("rp3", {
        store: r.store,
        dispatcher: r.dispatcher,
        registry,
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      });
    } finally {
      shutdown.abort();
      await sup.promise;
    }

    const state = r.store.getState("rp3")!;
    // Budget override applied once at run_started, never re-folded.
    expect(state.routing["budget_override.run.cost"]).toBe(5.0);
    // Steer delivered to the handler exactly once (no double-delivery).
    expect(seenSteering).toEqual(["focus on the auth module"]);
    // Not forwarded again through pi-agent-core's queue.
    expect(onSteerCalls).toEqual([]);
    // Handler ran to completion, never tripped.
    expect(sawAbort).toBe(false);

    r.store.close();
  });

  // Medium: a pre-claim steer whose first dispatched node is non-llm (tool /
  // human) must carry forward to the first llm step rather than being consumed.
  test("pre-claim steer with a non-llm first node carries forward to the first llm step", async () => {
    const yaml = [
      "name: t",
      "steps:",
      "  first: {type: tool, run: noop, next: second}",
      "  second: {type: llm, prompt: work}",
    ].join("\n");
    const r = rig({ yaml });
    let seenAtLlm: string | undefined;
    r.dispatcher.register(r.workflowSha, "first", {
      kind: "tool",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({ kind: "transition", nextNode: "second", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "second", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async (ctx) => {
        seenAtLlm = ctx.steering;
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "rp4", "first");
    r.store.appendIntent("rp4", {
      type: "intent.steering_requested",
      payload: { text: "focus on the auth module" },
    });
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

    // The steer reaches the first llm step (`second`), not silently consumed by
    // the non-llm `first` node.
    expect(seenAtLlm).toBe("focus on the auth module");

    r.store.close();
  });
});
