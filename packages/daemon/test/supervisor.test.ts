// Supervisor watchdog tests. Leak detection is driven by the registry's
// in-process elapsed time. A daemon that pauses for hours and resumes
// must not trip a fresh node just because wall-clock advanced while the
// process was down.

import { afterEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
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
  store.saveWorkflow(workflowSha, "t", `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`);
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
    store.appendFact(runId, [fact], v, { advanceAppliedTo: v });
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

  test("does not trip a controller for a node whose handlerMaxMsFor returns undefined", async () => {
    // Unbounded llm (max_ms=0) — the supervisor must skip the
    // leak-trip entirely, even after arbitrarily long elapsed time.
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = makeRunningStore("unbounded-1", "sha");
    const ctrl = new AbortController();
    registry.register("unbounded-1", ctrl);
    clk.advance(10_000_000);

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
      handlerMaxMsFor: () => undefined,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });
});

describe("supervisor — intent-aware abort policy", () => {
  // pi-agent-core's Agent.steer() enqueues into a steeringQueue that drains
  // at end-of-turn. Tripping the abort controller on a steer would kill the
  // in-flight LLM call and force the llm handler to classify the
  // resulting `stopReason: "aborted"` as fail (backend.ts:464-478) — exactly
  // the cancel/timeout collapse the comment there warns about. The supervisor
  // must hand steer text to the backend's queue and leave the controller alone.
  test("steer-only intent does not trip; calls onSteer with the text", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r1", "sha");
    const ctrl = new AbortController();
    registry.register("r1", ctrl);
    store.appendIntent("r1", { type: "intent.steering_requested", payload: { text: "redirect" } });

    const onSteerCalls: Array<{ runId: string; text: string }> = [];
    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      onSteer: (runId, text) => onSteerCalls.push({ runId, text }),
    });

    await new Promise((r) => setTimeout(r, 30));
    try {
      expect(ctrl.signal.aborted).toBe(false);
      expect(onSteerCalls).toEqual([{ runId: "r1", text: "redirect" }]);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  test("non-steer intent (cancel) trips the controller and does not call onSteer", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r2", "sha");
    const ctrl = new AbortController();
    registry.register("r2", ctrl);
    store.appendIntent("r2", { type: "intent.cancel_requested", payload: {} });

    const onSteerCalls: Array<{ runId: string; text: string }> = [];
    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      onSteer: (runId, text) => onSteerCalls.push({ runId, text }),
    });

    await new Promise((r) => setTimeout(r, 30));
    try {
      expect(ctrl.signal.aborted).toBe(true);
      expect(onSteerCalls).toEqual([]);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  // Mixed batch: a steer at seq N alongside a cancel at seq N+1 within the
  // same supervisor tick. The cancel wins (trips), and we don't bother
  // forwarding the steer — pi-agent-core would abort before draining the
  // queue anyway, and the run is going down. Keep the side-channel quiet.
  test("steer + cancel batch: trips and skips onSteer forwarding", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r3", "sha");
    const ctrl = new AbortController();
    registry.register("r3", ctrl);
    store.appendIntent("r3", { type: "intent.steering_requested", payload: { text: "ignored" } });
    store.appendIntent("r3", { type: "intent.cancel_requested", payload: {} });

    const onSteerCalls: Array<{ runId: string; text: string }> = [];
    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      onSteer: (runId, text) => onSteerCalls.push({ runId, text }),
    });

    await new Promise((r) => setTimeout(r, 30));
    try {
      expect(ctrl.signal.aborted).toBe(true);
      expect(onSteerCalls).toEqual([]);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  // Multiple steers across ticks should each fire onSteer once. lastIntentSeq
  // dedupe keeps a single steer from re-firing every tick while it sits
  // unapplied.
  test("steers fire onSteer exactly once each, even though they stay unapplied", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r4", "sha");
    const ctrl = new AbortController();
    registry.register("r4", ctrl);
    store.appendIntent("r4", { type: "intent.steering_requested", payload: { text: "first" } });

    const onSteerCalls: Array<{ runId: string; text: string }> = [];
    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      onSteer: (runId, text) => onSteerCalls.push({ runId, text }),
    });

    await new Promise((r) => setTimeout(r, 20));
    store.appendIntent("r4", { type: "intent.steering_requested", payload: { text: "second" } });
    await new Promise((r) => setTimeout(r, 20));

    try {
      expect(ctrl.signal.aborted).toBe(false);
      expect(onSteerCalls).toEqual([
        { runId: "r4", text: "first" },
        { runId: "r4", text: "second" },
      ]);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
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
