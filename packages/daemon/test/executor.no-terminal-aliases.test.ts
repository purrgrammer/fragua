// Only `exit` (the reserved sink) and the executor's `__end__` sentinel end a
// run. A step that happens to be named `done` or `end` is an ordinary step
// and must dispatch — the historical aliases silently skipped it.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — no terminal-name aliases", () => {
  test.each(["done", "end"])("a step named %s dispatches instead of terminating the run", async (name) => {
    const yaml = `name: t
steps:
  first: {type: llm, prompt: f, next: ${name}}
  ${name}: {type: llm, prompt: d, next: exit}
`;
    const r = rig({ yaml });
    const ran: string[] = [];
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "first", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "first", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        ran.push("first");
        return { kind: "transition", nextNode: name, tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, name, {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        ran.push(name);
        return { kind: "transition", nextNode: "exit", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "alias-run", "start");
    r.store.claimNextRun(1);
    await runOne("alias-run", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    expect(ran).toEqual(["first", name]);
    expect(r.store.getState("alias-run")?.status).toBe("completed");
  });
});
