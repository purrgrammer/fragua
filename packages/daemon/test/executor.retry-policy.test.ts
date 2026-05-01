// Retry-policy integration tests — attractor §3.5 / §3.6 wired through
// the executor. Covers (a) retry status with delayMs sleep + re-dispatch,
// (b) retry-counter exhaustion → halt(max_retries_exceeded), and (c)
// allow_partial converting exhaustion to PARTIAL_SUCCESS advance.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — retry-policy enforcement", () => {
  test("retry status under budget → re-dispatched and eventually succeeds", async () => {
    const dot = `digraph G {
      start [shape=Mdiamond];
      flaky [shape=box, max_retries=3, retry_policy="none"];
      done [shape=Msquare];
      start -> flaky -> done;
    }`;
    const r = rig({ dot });
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
    r.store.claimNextRun(1);
    await runOne("rp1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 30,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp1")!;
    expect(state.status).toBe("completed");
    expect(attempts).toBe(3); // 1 initial + 2 retries before success

    const events = r.store.getEvents("rp1");
    const scheduled = events.filter((e) => e.type === "node.retry_scheduled");
    expect(scheduled.length).toBe(2); // two retries scheduled
    r.store.close();
  });

  test("max_retries=0 + retry status → halt(max_retries_exceeded) immediately", async () => {
    const dot = `digraph G {
      start [shape=Mdiamond];
      flaky [shape=box, max_retries=0];
      done [shape=Msquare];
      start -> flaky -> done;
    }`;
    const r = rig({ dot });
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
    r.store.claimNextRun(1);
    await runOne("rp2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp2")!;
    expect(state.status).toBe("halted");
    const halt = r.store.getEvents("rp2").find((e) => e.type === "fact.run_halted");
    expect((halt?.payload as { reason: string }).reason).toBe("max_retries_exceeded");
    r.store.close();
  });

  test("allow_partial=true on exhaustion → advance with PARTIAL_SUCCESS", async () => {
    const dot = `digraph G {
      start [shape=Mdiamond];
      flaky [shape=box, max_retries=0, allow_partial=true];
      done [shape=Msquare];
      start -> flaky -> done;
    }`;
    const r = rig({ dot });
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
    r.store.claimNextRun(1);
    await runOne("rp3", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rp3")!;
    expect(state.status).toBe("completed");
    const events = r.store.getEvents("rp3");
    const accept = events.find((e) => e.type === "node.retry_partial_accept");
    expect(accept).toBeDefined();
    // The flaky node's node_completed payload reports outcome=partial_success.
    const completed = events
      .filter((e) => e.type === "fact.node_completed")
      .find((e) => (e.payload as { nodeId: string }).nodeId === "flaky");
    expect((completed?.payload as { outcomeStatus?: string }).outcomeStatus).toBe("partial_success");
    r.store.close();
  });
});
