// A caller's per-node `max-cost` bounds caller PLUS worker spend. An `agent`-tool
// worker emits `cost.recorded` through the caller's emit stamped with its own
// synthetic node id (`__agent.<caller>#<n>/<call>`); the reactive gate keys the
// bucket on the DISPATCHED node, never on the payload's `nodeId`, so delegated
// spend cannot slip past the caller's cap mid-turn.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";
import { dispositionType } from "./invariants.ts";

describe("executor — worker cost.recorded counts against the caller's node bucket", () => {
  test("cost.recorded stamped with a synthetic worker node id trips the caller's max-cost mid-turn", async () => {
    const yaml = `name: t
budget-policy: stop
steps:
  work: {type: llm, prompt: o, max-cost: 1.0}
`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    let returnedCleanly = false;
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        const slice = (nodeId: string) =>
          ctx.emit("cost.recorded", {
            nodeId,
            total_tokens: 1000,
            cost_usd: 0.4,
            input_tokens: 500,
            output_tokens: 500,
            model: "test/model",
          });
        slice("work");
        slice("__agent.work#0/toolu_a");
        slice("__agent.work#0/toolu_b");
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
    enqueue(r, "rb-worker", "start");
    r.store.claimNextRun(1);
    await runOne("rb-worker", {
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
    expect(r.store.getState("rb-worker")!.status).toBe("halted");
    const types = r.store.getEvents("rb-worker").map(dispositionType);
    expect(types).toContain("budget.stop");
    expect(types).toContain("fact.node_aborted");
    expect(types.indexOf("budget.stop")).toBeLessThan(types.indexOf("fact.node_aborted"));
  });
});
