// Budget enforcement — end-to-end through the executor.
// Default budget_policy is "pause": breach pauses for operator decision.
// Explicit budget_policy="stop" keeps the terminal-on-overspend behavior
// for CI gates. budget_policy="warn" never blocks.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — budget enforcement", () => {
  test("graph budget_usd=1.0 (default policy=pause); breach mid-run → paused, reason=budget", async () => {
    // Non-terminal next node so the pause path is exercised independent
    // of any terminal-transition interaction. See the
    // "breach on terminal turn → completed" test below for that case.
    const dot = `digraph G {
      graph [budget_usd=1.0];
      start [shape=Mdiamond];
      spend [shape=box];
      checkpoint [shape=box];
      done [shape=Msquare];
      start -> spend;
      spend -> checkpoint;
      checkpoint -> done;
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
        nextNode: "checkpoint",
        tokens: 100,
        costUsd: 1.5,
      }),
    });
    r.dispatcher.register(r.workflowSha, "checkpoint", {
      kind: "codergen",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "done", tokens: 0, costUsd: 0 }),
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
    expect(state.status).toBe("paused");

    const events = r.store.getEvents("rb1");
    const types = events.map((e) => e.type);
    const stopIdx = types.indexOf("budget.stop");
    const pauseIdx = types.indexOf("fact.run_paused");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(pauseIdx);

    const pause = events[pauseIdx]!;
    const p = pause.payload as { reason: string; scope: string; metric: string; limit: number; actual: number };
    expect(p.reason).toBe("budget");
    expect(p.scope).toBe("run");
    expect(p.metric).toBe("cost");
    expect(p.limit).toBe(1.0);
    expect(p.actual).toBeGreaterThanOrEqual(1.5);
    expect(types).not.toContain("fact.run_halted");

    r.store.close();
  });

  test("breach on terminal turn → completed (not paused, prevents resume-of-Msquare crash)", async () => {
    // Regression test: when a turn breaches budget AND its transition
    // is to a terminal sentinel (Msquare / done / __end__),
    // result-to-facts emits `fact.run_completed`. Adding a redundant
    // `fact.run_paused` afterwards used to clobber the terminal status
    // in the reducer (paused wins because it's last) and leave
    // `currentNode = "done"`. On resume the executor would dispatch
    // `done`, fail to find a handler (Msquare terminals have no
    // handlers in real workflows), and crash with "no handler
    // registered for <sha>::done" (or `__end__` if `done` itself had
    // a handler chain). Fix: skip the pause-fact swap when the
    // result is already terminal.
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
      handler: async () => ({ kind: "transition", nextNode: "done", tokens: 100, costUsd: 1.5 }),
    });
    // Deliberately do NOT register a handler for `done` — Msquare
    // terminals have no handlers in real workflows. If the fix
    // regresses, the executor will try to dispatch `done` on resume
    // and crash; this test catches that by asserting `completed`.
    enqueue(r, "rb-term", "start");
    r.store.claimNextRun(1);
    await runOne("rb-term", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rb-term")!;
    expect(state.status).toBe("completed");

    const types = r.store.getEvents("rb-term").map((e) => e.type);
    expect(types).toContain("budget.stop"); // budget signal still fires
    expect(types).toContain("fact.run_completed");
    expect(types).not.toContain("fact.run_paused"); // suppressed by the terminal-transition guard
    expect(types).not.toContain("fact.run_halted");

    r.store.close();
  });

  test("budget_policy=stop; handler costs 1.5 → status=halted, reason=budget", async () => {
    const dot = `digraph G {
      graph [budget_usd=1.0, budget_policy="stop"];
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
    enqueue(r, "rb-stop", "start");
    r.store.claimNextRun(1);
    await runOne("rb-stop", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("rb-stop")!;
    expect(state.status).toBe("halted");

    const events = r.store.getEvents("rb-stop");
    const types = events.map((e) => e.type);
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
