// Graph-level routing seeding at run start. Regression: a workflow with a
// `description:` (parsed to the graph `label` attr) used to be seeded into
// routing as "graph.label" — a key outside the routing-key vocabulary — so
// the write gate crashed the executor before the first node ran. The label
// must stay out of routing entirely; the goal still seeds.

import { describe, expect, test } from "bun:test";
import { GRAPH_GOAL_KEY } from "@fragua/core";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — graph metadata seeding at run start", () => {
  test("a workflow with a description completes; label never enters routing", async () => {
    const yaml = [
      "name: t",
      "goal: ship it",
      "description: |",
      "  Long authored prose about what this workflow replaces and why.",
      "  Multi-line, and irrelevant to dispatch decisions.",
      "steps:",
      "  work: {type: llm, prompt: hi}",
      "",
    ].join("\n");
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "step",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "seed-1", "work");
    r.store.claimNextRun(1);
    await runOne("seed-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: new AbortController().signal,
    });

    const final = r.store.getState("seed-1");
    expect(final).not.toBeNull();
    expect(final!.status).toBe("completed");
    expect(final!.routing[GRAPH_GOAL_KEY]).toBe("ship it");
    expect("graph.label" in final!.routing).toBe(false);
  });
});
