// Pre-claim intents — operator intents appended while a run is `queued`
// (before the executor claims it) must survive the `run_started` turn.
// docs/intent-fold.md lists `queued` as a valid state for budget_adjusted
// and steering_requested; the fold consumes them on the first turn.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
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
});
