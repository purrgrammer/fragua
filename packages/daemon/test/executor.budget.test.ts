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
    const yaml = `name: t
budget: 1.0
steps:
  spend: {type: llm, prompt: s, next: checkpoint}
  checkpoint: {type: llm, prompt: c}
`;
    const r = rig({ yaml });
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
    const yaml = `name: t
budget: 1.0
steps:
  spend: {type: llm, prompt: s}
`;
    const r = rig({ yaml });
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
    const yaml = `name: t
budget: 1.0
budget-policy: stop
steps:
  spend: {type: llm, prompt: s}
`;
    const r = rig({ yaml });
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

    // Projection-on-halt: fact.node_completed for the breaching turn
    // must land before the halt so total_cost_usd + nodeCosts capture
    // the spend the gate halted on. Pre-fix, the halt branch overwrote
    // result to `{kind:"halt"}` which made resultToFacts skip
    // node_completed entirely; the projection lagged the gate's
    // `actual` by exactly the breaching turn's cost.
    const completedIdx = events.findIndex(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "spend",
    );
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeLessThan(haltIdx);
    expect(state.metrics.totalCostUsd).toBeCloseTo(1.5, 6);
    expect(state.metrics.nodeCosts["spend"]?.costUsd).toBeCloseTo(1.5, 6);
    // No competing terminal facts — the breaching turn's transition
    // would have produced fact.run_completed; the halt block must
    // strip it so the reducer doesn't see a successful completion.
    expect(types.filter((t) => t === "fact.run_completed")).toHaveLength(0);
    expect(types.filter((t) => t === "fact.run_halted")).toHaveLength(1);

    r.store.close();
  });

  test("budget_policy=warn → over-budget emits stop event but run completes", async () => {
    const yaml = `name: t
budget: 1.0
budget-policy: warn
steps:
  spend: {type: llm, prompt: s}
`;
    const r = rig({ yaml });
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
    const yaml = `name: t
budget: 1.0
steps:
  a: {type: llm, prompt: x, next: b}
  b: {type: llm, prompt: y}
`;
    const r = rig({ yaml });
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

  test("reactive: cost.recorded mid-handler crosses stop ceiling → abort + halt with partial cost preserved", async () => {
    // Models the orchestrate-with-sub-agents case: a single parent
    // turn streams cost.recorded events as sub-agents return. Without
    // the reactive check, the entire fan-out spends inside one turn
    // before the post-handler boundary sees the breach (5×+ overshoot
    // observed on real runs). The reactive gate trips the abort the
    // first time cumulative spend crosses the ceiling, so overshoot
    // is bounded by one in-flight LLM message rather than the whole
    // sub-agent fan-out.
    const yaml = `name: t
budget: 1.0
budget-policy: stop
steps:
  orchestrate: {type: llm, prompt: o}
`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "orchestrate", tokens: 0, costUsd: 0 }),
    });
    let returnedCleanly = false;
    r.dispatcher.register(r.workflowSha, "orchestrate", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        // Three "sub-agent" cost slices. The third pushes the running
        // total past the ceiling (0.4 + 0.4 + 0.4 = 1.2 ≥ 1.0). The
        // reactive gate must abort BEFORE we get a chance to "complete"
        // the work and return.
        ctx.emit("cost.recorded", {
          total_tokens: 1000,
          cost_usd: 0.4,
          input_tokens: 500,
          output_tokens: 500,
          model: "test/model",
        });
        ctx.emit("cost.recorded", {
          total_tokens: 1000,
          cost_usd: 0.4,
          input_tokens: 500,
          output_tokens: 500,
          model: "test/model",
        });
        ctx.emit("cost.recorded", {
          total_tokens: 1000,
          cost_usd: 0.4,
          input_tokens: 500,
          output_tokens: 500,
          model: "test/model",
        });
        // Wait for the abort the reactive gate triggered; raise
        // AbortError when it fires.
        await new Promise<void>((_, reject) => {
          const onAbort = (): void => {
            ctx.signal.removeEventListener("abort", onAbort);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
        returnedCleanly = true;
        return { kind: "transition", nextNode: "done", tokens: 0, costUsd: 0 } as const;
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rb-reactive", "start");
    r.store.claimNextRun(1);
    await runOne("rb-reactive", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    expect(returnedCleanly).toBe(false);
    const state = r.store.getState("rb-reactive")!;
    expect(state.status).toBe("halted");

    const events = r.store.getEvents("rb-reactive");
    const types = events.map((e) => e.type);
    expect(types).toContain("budget.stop");
    expect(types).toContain("fact.node_aborted");
    expect(types).toContain("fact.run_halted");
    // budget.stop emits before the abort fact (it's pushed into
    // observability the moment the reactive check trips); abort fact
    // and halt fact land in the same atomic commit.
    expect(types.indexOf("budget.stop")).toBeLessThan(types.indexOf("fact.node_aborted"));
    expect(types.indexOf("fact.node_aborted")).toBeLessThan(types.indexOf("fact.run_halted"));

    const halt = events.find((e) => e.type === "fact.run_halted")!;
    expect((halt.payload as { reason: string }).reason).toBe("budget");

    // Partial cost on the abort fact captures every cost.recorded the
    // handler emitted before the abort fired. That's at least the
    // first three slices ($1.20); could be exactly that if the abort
    // landed atomically before any further emits.
    const aborted = events.find((e) => e.type === "fact.node_aborted")!;
    const partial = aborted.payload as { partialCostUsd: number };
    expect(partial.partialCostUsd).toBeCloseTo(1.2, 6);

    r.store.close();
  });
});
