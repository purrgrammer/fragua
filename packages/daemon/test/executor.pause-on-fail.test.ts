// Pause + fail-route — see the bug repro from run 01kqn91nzxfrjgwvgh.
//
// When the operator hits Pause while a codergen is mid-stream, pi-ai
// returns `stopReason="aborted"` and the agent boundary converts that
// to a normal `fail` outcome (not a thrown AbortError). Without the
// fact.run_halted entry in the pause-after-dispatch swap set, the run
// halted with reason="aborted_exit" instead of pausing.
//
// This test registers a node that returns outcomeStatus="fail" routing
// to the start node's only outgoing edge (which lands on `__end__`),
// folds an unapplied `intent.pause_requested` into the dispatch, and
// asserts the run lands in `paused_hitl` — not halted.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — pause swaps a fail-routed halt for paused_hitl", () => {
  test("fail outcome + folded pause intent → paused_hitl, not halted", async () => {
    const r = rig({
      dot: `digraph {
        start [shape=Mdiamond];
        impl  [shape=box];
        done  [shape=Msquare];
        start -> impl;
        impl -> done;
      }`,
    });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      // Mimic the pi-ai-aborted-mid-stream → fail outcome path: handler
      // returns a normal transition with outcomeStatus="fail" and
      // failureReason="Request was aborted." (the pi-ai message).
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        failureReason: "Request was aborted.",
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

    enqueue(r, "pause-fail", "start");
    r.store.claimNextRun(1);

    // Append a pause intent BEFORE runOne so the fold sees it on the
    // codergen's dispatch. Mirrors what supervisor.ts does when the
    // operator clicks Pause during a running turn.
    r.store.appendIntent("pause-fail", { type: "intent.pause_requested", payload: {} });

    await runOne("pause-fail", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("pause-fail");
    const halts = events.filter((e) => e.type === "fact.run_halted");
    expect(halts.length).toBe(0);
    const paused = events.filter((e) => e.type === "fact.run_paused_hitl");
    expect(paused.length).toBe(1);
    const state = r.store.getState("pause-fail");
    expect(state?.status).toBe("paused_hitl");
  });
});
