// Supervisor watchdog tests. Leak detection is driven by the registry's
// in-process elapsed time. A daemon that pauses for hours and resumes
// must not trip a fresh node just because wall-clock advanced while the
// process was down.

import { afterEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { HandlerLeakedError, startSupervisor, sweepOrphanChildren } from "../src/supervisor.ts";

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
});

describe("supervisor — intent-aware abort policy", () => {
  // pi-agent-core's Agent.steer() enqueues into a steeringQueue that drains
  // at end-of-turn. Tripping the abort controller on a steer would kill the
  // in-flight LLM call and force the codergen handler to classify the
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

describe("sweepOrphanChildren", () => {
  function seedTerminal(store: SqliteStore, runId: string, status: "completed" | "halted" | "cancelled"): void {
    store.saveWorkflow("wf", "t", "digraph{}");
    store.enqueueRun({ runId, workflowSha: "wf" });
    const claimed = store.claimNextRun(10);
    expect(claimed?.runId).toBe(runId);
    const live = store.getState(runId)!;
    const fact =
      status === "completed"
        ? {
            type: "fact.run_started" as const,
            payload: { workflowSha: "wf", schemaVersion: live.schemaVersion, startNode: "a" },
          }
        : null;
    if (fact != null) {
      store.appendFact(runId, [fact], live.version);
    }
    const terminalFact =
      status === "completed"
        ? { type: "fact.run_completed" as const, payload: { finalNode: "a" } }
        : status === "halted"
          ? { type: "fact.run_halted" as const, payload: { reason: "error" as const, detail: "" } }
          : { type: "fact.run_cancelled" as const, payload: { intentSeq: 0 } };
    const v2 = store.getState(runId)!.version;
    store.appendFact(runId, [terminalFact], v2);
  }

  test("boot sweep cancels orphan children whose parent is terminal", () => {
    const store = new SqliteStore({ path: ":memory:" });
    seedTerminal(store, "parent-1", "completed");
    store.enqueueConversation({
      runId: "child-1",
      parentRunId: "parent-1",
      parentNodeId: "plan",
      parentIteration: 0,
    });

    const cancelled = sweepOrphanChildren(store);
    expect(cancelled).toBe(1);

    const intents = store.getEvents("child-1").filter((e) => e.type === "intent.cancel_requested");
    expect(intents).toHaveLength(1);
    expect((intents[0]?.payload as { reason: string })?.reason).toBe("parent terminal");
    store.close();
  });

  test("boot sweep leaves children alone when the parent is still active", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("wf", "t", "digraph{}");
    store.enqueueRun({ runId: "parent-2", workflowSha: "wf" });
    store.enqueueConversation({
      runId: "child-2",
      parentRunId: "parent-2",
      parentNodeId: "plan",
      parentIteration: 0,
    });

    const cancelled = sweepOrphanChildren(store);
    expect(cancelled).toBe(0);

    const intents = store.getEvents("child-2").filter((e) => e.type === "intent.cancel_requested");
    expect(intents).toHaveLength(0);
    store.close();
  });

  test("boot sweep skips children that are themselves terminal", () => {
    const store = new SqliteStore({ path: ":memory:" });
    seedTerminal(store, "parent-3", "completed");
    store.enqueueConversation({
      runId: "child-3",
      parentRunId: "parent-3",
      parentNodeId: "plan",
      parentIteration: 0,
    });
    // Drive the child to terminal so it's no longer an orphan.
    const v0 = store.getState("child-3")!.version;
    store.appendFact("child-3", [{ type: "fact.run_halted", payload: { reason: "error", detail: "manual" } }], v0);

    const cancelled = sweepOrphanChildren(store);
    expect(cancelled).toBe(0);
    store.close();
  });
});
