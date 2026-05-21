// Regression: a llm-shaped handler that emits cost.recorded
// events (via ctx.emit, the way handler-bridge does) and is then
// aborted by its own maxMs MUST surface those costs on
// fact.node_aborted.{partialTokens, partialCostUsd}, and the
// store reducer must fold them into run_state.metrics.totalCostUsd.
//
// Today the executor's abort path reads its own LlmAccounting
// accumulator (turnBilled / totalCostUsd) which is fed only by
// ctx.llm.call(). Llm handlers bypass ctx.llm and aggregate
// cost.recorded into local closures inside makeLlmHandler;
// when the handler aborts mid-turn, those closures never reach
// the executor and the resulting fact.node_aborted carries
// partialTokens=0 / partialCostUsd=0. Real-world consequence on
// ~/.fragua/fragua.db run 01kqwzpt0hyfws0a0j: 423 cost.recorded
// events totalling ~$16.79, fact.node_aborted rows on the
// orchestrate-node node show partialCostUsd=0, run_state.metrics
// .totalCostUsd=0, budget_usd never trips.
//
// Per AGENTS.md ground rule #5: do NOT fold cost.recorded directly
// in the reducer (observability events deliberately bypass reducers;
// folding would double-count completed-node turns whose cost.recorded
// events also fire). The fix lives on the executor abort path /
// handler-bridge accumulator surfacing.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — abort path surfaces handler-emitted cost.recorded as partial usage", () => {
  test("aborted llm-shaped handler reports partial tokens/cost on fact.node_aborted and in run_state.metrics", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    // Llm-shaped handler: emit cost.recorded the way
    // handler-bridge does (via ctx.emit, not via ctx.llm.call —
    // llm bypasses LlmAccounting entirely), then hang until
    // maxMs trips. This mirrors what PiLlmBackend does between
    // the first message_end and the abort trigger on a long run.
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 30,
      handler: async (ctx) => {
        ctx.emit("cost.recorded", {
          total_tokens: 1500,
          cost_usd: 0.42,
          input_tokens: 1000,
          output_tokens: 500,
          model: "anthropic/claude-opus-4-7",
        });
        ctx.emit("cost.recorded", {
          total_tokens: 800,
          cost_usd: 0.13,
          input_tokens: 600,
          output_tokens: 200,
          model: "anthropic/claude-opus-4-7",
        });
        return await new Promise<never>((_, reject) => {
          const onAbort = () => {
            ctx.signal.removeEventListener("abort", onAbort);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "abort-cost-1", "start");
    await runOne("abort-cost-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      leakGraceMs: 500,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("abort-cost-1");
    const allAborted = events.filter(
      (e) => e.type === "fact.node_aborted" && (e.payload as { nodeId: string }).nodeId === "impl",
    );
    expect(allAborted.length).toBeGreaterThan(0);
    type AbortPayload = {
      cause: string;
      partialTokens: number;
      partialCostUsd: number;
      partialInputTokens?: number;
      partialOutputTokens?: number;
    };
    const firstPayload = allAborted[0]!.payload as AbortPayload;
    // Sanity: this is the timeout path, the test rig is correct.
    expect(firstPayload.cause).toBe("timeout");

    // The two cost.recorded events sum to 2300 tokens / $0.55 —
    // the partial accumulator on fact.node_aborted MUST reflect
    // that turn's spend. Before the fix both fields were 0 because
    // the executor's LlmAccounting never saw the handler-emitted
    // costs (llm bypasses ctx.llm.call). Each subsequent
    // retry-on-abort dispatches the handler fresh and emits the
    // same cost.recorded pair, so every fact.node_aborted carries
    // its own turn's partial — not a cumulative total.
    for (const fact of allAborted) {
      const p = fact.payload as AbortPayload;
      expect(p.partialTokens).toBe(2300);
      expect(p.partialCostUsd).toBeCloseTo(0.55, 6);
      expect(p.partialInputTokens).toBe(1600);
      expect(p.partialOutputTokens).toBe(700);
    }

    // Reducer must fold the partial fields from every fact.node_aborted
    // into run_state.metrics so budget_usd / max_cost_usd reads stay
    // accurate against aborted runs. Cumulative total is N × per-turn.
    const expectedCost = 0.55 * allAborted.length;
    const expectedTokens = 2300 * allAborted.length;
    const state = r.store.getState("abort-cost-1")!;
    expect(state.metrics.totalCostUsd).toBeCloseTo(expectedCost, 6);
    expect(state.metrics.totalInputTokens).toBe(1600 * allAborted.length);
    expect(state.metrics.totalOutputTokens).toBe(700 * allAborted.length);
    expect(state.metrics.billedTokens).toBe(expectedTokens);
    expect(state.metrics.nodeCosts["impl"]?.costUsd).toBeCloseTo(expectedCost, 6);

    r.store.close();
  });
});
