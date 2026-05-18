// Regression: a throw in the per-turn build section (graph load,
// context build, …) must not leave a stale AbortRegistry entry. The
// fix moves `register` to sit immediately before the handler
// `try`/`finally` — ahead of it, a build-path throw leaked the entry
// because the sole `unregister` lives in that `finally`, and the next
// claim of the same runId then tripped `register`'s already-registered
// guard.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

describe("executor — AbortRegistry is not leaked on a build-path throw", () => {
  test("a store fault thrown mid-build leaves the registry clean", async () => {
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
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 }),
    });
    registerTerminalEcho(r.dispatcher, r.workflowSha, "done");

    // Fault-inject a store read used inside the per-turn build block,
    // ahead of the handler dispatch. Every other surface passes through
    // untouched so the run still halts cleanly.
    const faultyStore = new Proxy(r.store, {
      get(target, prop, receiver) {
        if (prop === "getWorkflow") {
          return () => {
            throw new Error("simulated store fault");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    enqueue(r, "leak-run", "start");
    r.store.claimNextRun(1);

    const reg = new AbortRegistry();
    await expect(
      runOne("leak-run", {
        store: faultyStore,
        dispatcher: r.dispatcher,
        registry: reg,
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    // The build-path throw must not have leaked a registration.
    expect(reg.has("leak-run")).toBe(false);
    expect(reg.activeRuns()).toEqual([]);
  });
});
