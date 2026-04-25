// Budget enforcement — end-to-end through the executor.
// Drives a real run with a configured ceiling and a handler that overspends;
// asserts the run halts with reason="budget" and the fact stream contains
// `budget.stop` before `fact.run_halted`.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — budget enforcement", () => {
  test("graph budget_usd=1.0; handler costs 1.5 → status=halted, reason=budget", async () => {
    const dot = `digraph G {
      graph [budget_usd=1.0];
      start [shape=Mdiamond];
      spend [shape=box];
      done [shape=Msquare];
      start -> spend;
      spend -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "spend", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "spend", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        nextNode: "done",
        tokens: 100,
        costUsd: 1.5,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rb1", "start");
    r.store.claimNextRun(1);
    await runOne("rb1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rb1")!;
    expect(state.status).toBe("halted");

    const events = r.store.getEvents("rb1");
    const types = events.map((e) => e.type);
    // Causal order: budget.stop emitted as observability before fact.run_halted commits.
    const stopIdx = types.indexOf("budget.stop");
    const haltIdx = types.indexOf("fact.run_halted");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(haltIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(haltIdx);

    const halt = events[haltIdx]!;
    expect((halt.payload as { reason: string }).reason).toBe("budget");
    expect(typeof (halt.payload as { detail?: string }).detail).toBe("string");

    r.store.close();
  });

  test("budget_policy=warn → over-budget emits stop event but run completes", async () => {
    const dot = `digraph G {
      graph [budget_usd=1.0, budget_policy="warn"];
      start [shape=Mdiamond];
      spend [shape=box];
      done [shape=Msquare];
      start -> spend;
      spend -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "spend", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "spend", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "done", tokens: 100, costUsd: 1.5 }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rb2", "start");
    r.store.claimNextRun(1);
    await runOne("rb2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rb2")!;
    expect(state.status).toBe("completed");
    const types = r.store.getEvents("rb2").map((e) => e.type);
    expect(types).toContain("budget.stop");
    expect(types).toContain("fact.run_completed");
    expect(types).not.toContain("fact.run_halted");

    r.store.close();
  });

  test("warn threshold fires once per run (no re-fire on subsequent dispatches)", async () => {
    // Two-step spend: first turn brings cumulative to 0.85 (above warn), second
    // turn brings it to 0.95 (still above warn but we already warned). Expect
    // exactly one budget.warn in the event stream.
    const dot = `digraph G {
      graph [budget_usd=1.0];
      start [shape=Mdiamond];
      a [shape=box];
      b [shape=box];
      done [shape=Msquare];
      start -> a;
      a -> b;
      b -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "a", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "a", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "b", tokens: 0, costUsd: 0.85 }),
    });
    r.dispatcher.register(r.workflowSha, "b", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "done", tokens: 0, costUsd: 0.1 }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rb3", "start");
    r.store.claimNextRun(1);
    await runOne("rb3", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const types = r.store.getEvents("rb3").map((e) => e.type);
    const warns = types.filter((t) => t === "budget.warn");
    expect(warns).toHaveLength(1);
    expect(r.store.getState("rb3")!.status).toBe("completed");
    r.store.close();
  });
});
