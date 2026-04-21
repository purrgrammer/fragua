// Supervisor watchdog tests. Leak detection is driven by the registry's
// in-process elapsed time. A daemon that pauses for hours and resumes
// must not trip a fresh node just because wall-clock advanced while the
// process was down.

import { afterEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { HandlerLeakedError, startSupervisor } from "../src/supervisor.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

function makeRunningStore(runId: string, workflowSha: string): SqliteStore {
  const store = new SqliteStore({ path: ":memory:" });
  closers.push(() => store.close());
  store.saveWorkflow(
    workflowSha,
    "t",
    `digraph { start [shape=Mdiamond]; impl [shape=box]; done [shape=Msquare]; start -> impl -> done; }`,
  );
  store.enqueueRun({ runId, workflowSha, initialRouting: { start_node: "start" } });
  store.claimNextRun(1);
  const facts = [
    { type: "fact.run_started" as const, payload: { workflowSha, schemaVersion: 1, startNode: "start" } },
    {
      type: "fact.node_completed" as const,
      payload: { nodeId: "start", iteration: 0, tokens: 0, costUsd: 0, nextNode: "impl" },
    },
    { type: "fact.node_started" as const, payload: { nodeId: "impl", iteration: 0 } },
  ];
  for (const fact of facts) {
    const v = store.getState(runId)?.version ?? 0;
    store.appendFact(runId, [fact], v, { advanceAppliedTo: 99 });
  }
  return store;
}

function fakeClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("supervisor — pause-aware leak detection", () => {
  test("does not trip a freshly-registered controller", async () => {
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = makeRunningStore("r1", "sha");
    const ctrl = new AbortController();
    registry.register("r1", ctrl);

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
      handlerMaxMsFor: () => 1_000,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  test("trips after registry elapsed crosses maxMs + leakGrace (threshold property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 10_000 }), fc.integer({ min: 50, max: 1_000 }), (maxMs, leakGrace) => {
        const clk = fakeClock(0);
        const registry = new AbortRegistry(clk.now);
        registry.register("r", new AbortController());

        clk.advance(maxMs + leakGrace);
        expect((registry.elapsedMs("r") ?? 0) > maxMs + leakGrace).toBe(false);

        clk.advance(1);
        expect((registry.elapsedMs("r") ?? 0) > maxMs + leakGrace).toBe(true);
      }),
    );
  });

  test("cross-process reset: unregister + re-register resets the budget", () => {
    const clk = fakeClock(0);
    const registry = new AbortRegistry(clk.now);
    registry.register("r", new AbortController());
    clk.advance(50_000);
    expect(registry.elapsedMs("r")).toBe(50_000);
    registry.unregister("r");
    clk.advance(600_000);
    registry.register("r", new AbortController());
    expect(registry.elapsedMs("r")).toBe(0);
  });
});

describe("HandlerLeakedError", () => {
  test("carries runId + nodeId and reports as AbortError", () => {
    const e = new HandlerLeakedError("r1", "impl");
    expect(e.runId).toBe("r1");
    expect(e.nodeId).toBe("impl");
    expect(e.name).toBe("AbortError");
    expect(e.message).toMatch(/r1/);
    expect(e.message).toMatch(/impl/);
  });
});
