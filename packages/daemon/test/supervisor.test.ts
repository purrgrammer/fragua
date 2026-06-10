// Supervisor watchdog tests. Leak detection is driven by the registry's
// in-process elapsed time. A daemon that pauses for hours and resumes
// must not trip a fresh node just because wall-clock advanced while the
// process was down.

import { afterEach, describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
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
  store.saveWorkflow(
    workflowSha,
    "t",
    `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`,
    serializeGraph(parseWorkflow(`name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`)),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId, workflowSha, initialRouting: { start_node: "start" } });
  store.claimNextRun(1);
  const facts = [
    { type: "fact.run_started" as const, payload: { workflowSha, contractVersion: 1, startNode: "start" } },
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
    registry.register("r1", ctrl, "impl", 1_000);

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  test("trips after registry elapsed crosses the armed deadline + leakGrace (threshold property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 10_000 }),
        fc.integer({ min: 50, max: 1_000 }),
        (deadlineMs, leakGrace) => {
          const clk = fakeClock(0);
          const registry = new AbortRegistry(clk.now);
          registry.register("r", new AbortController(), "n", deadlineMs);

          clk.advance(deadlineMs + leakGrace);
          const at = registry.liveHandlers("r")[0]!;
          expect(at.elapsedMs > (at.deadlineMs ?? 0) + leakGrace).toBe(false);

          clk.advance(1);
          const past = registry.liveHandlers("r")[0]!;
          expect(past.elapsedMs > (past.deadlineMs ?? 0) + leakGrace).toBe(true);
        },
      ),
    );
  });

  test("cross-process reset: dispose + re-register resets the budget", () => {
    const clk = fakeClock(0);
    const registry = new AbortRegistry(clk.now);
    const dispose = registry.register("r", new AbortController());
    clk.advance(50_000);
    expect(registry.liveHandlers("r")[0]!.elapsedMs).toBe(50_000);
    dispose();
    clk.advance(600_000);
    registry.register("r", new AbortController());
    expect(registry.liveHandlers("r")[0]!.elapsedMs).toBe(0);
  });

  test("does not trip a controller registered without a deadline (intentionally unbounded)", async () => {
    // Unbounded llm (max_ms=0, no fan-out backstop) — invoke-handler stamps no
    // deadline, and the supervisor must skip the leak-trip entirely, even after
    // arbitrarily long elapsed time.
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = makeRunningStore("unbounded-1", "sha");
    const ctrl = new AbortController();
    registry.register("unbounded-1", ctrl, "impl");
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
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  /** Seed a claimed run pinned to a `parallel` node with in-flight branches. */
  function seedFanout(store: SqliteStore, branches: string[] = ["b1"]): void {
    const wfSrc = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    store.saveWorkflow("sha", "t", wfSrc, serializeGraph(parseWorkflow(wfSrc)), CURRENT_IR_VERSION);
    store.enqueueRun({ runId: "fo", workflowSha: "sha", initialRouting: { start_node: "lenses" } });
    store.claimNextRun(1);
    const seed = [
      { type: "fact.run_started" as const, payload: { workflowSha: "sha", contractVersion: 2, startNode: "lenses" } },
      { type: "fact.fanout_started" as const, payload: { nodeId: "lenses", iteration: 0, branches } },
    ];
    for (const fact of seed) {
      const v = store.getState("fo")?.version ?? 0;
      store.appendFact("fo", [fact], v, { advanceAppliedTo: v });
    }
  }

  test("fan-out: each branch is budgeted against its OWN armed deadline — a short branch trips while a long sibling is spared", async () => {
    // The review's finding: the watchdog budgeted the whole set against the
    // LONGEST branch, so a short-deadline branch evaded detection until the
    // longest sibling expired. Both branches here registered at the same instant
    // (identical elapsed), but only the short-deadline one must trip.
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = new SqliteStore({ path: ":memory:" });
    closers.push(() => store.close());
    seedFanout(store, ["short", "long"]);
    const shortCtrl = new AbortController();
    const longCtrl = new AbortController();
    registry.register("fo", shortCtrl, "short", 100);
    registry.register("fo", longCtrl, "long", 100_000);
    clk.advance(2_000); // past short's 100ms + grace, far under long's 100_000ms

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(shortCtrl.signal.aborted).toBe(true); // exceeded ITS OWN deadline
      expect(longCtrl.signal.aborted).toBe(false); // the long sibling is untouched
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  test("fan-out: a parallel node's RAISED timeout-minutes governs — no force-abort at a flat default", async () => {
    // The review's finding: the executor armed each branch against the parallel
    // node's own `timeout-minutes:` (45min here) while the watchdog budgeted
    // unbounded branches against a flat 20-minute config mirror — a legitimately
    // configured 45-minute branch was force-aborted at ~20min, re-driven, killed
    // again, and parked via abort_loop. The armed deadline now rides the
    // registry entry, so there is no second opinion to disagree with.
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = new SqliteStore({ path: ":memory:" });
    closers.push(() => store.close());
    seedFanout(store);
    const ctrl = new AbortController();
    const RAISED = 45 * 60_000; // what invoke-handler stamps: the parallel node's max_ms backstop
    registry.register("fo", ctrl, "b1", RAISED);
    clk.advance(21 * 60_000); // past the OLD 20-minute default + any grace, under 45min

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(false); // the author's 45min bound governs
      clk.advance(25 * 60_000); // now past 45min + grace — the leak backstop still works
      await new Promise((r) => setTimeout(r, 20));
      expect(ctrl.signal.aborted).toBe(true);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  test("fan-out: an abort-ignoring branch is reclaimable at its armed backstop — never skipped", async () => {
    // A fan-out branch ALWAYS registers with a deadline (invoke-handler passes
    // the branch backstop as maxMsOverride even for unbounded llm branches), so
    // a runaway branch that ignores its abort signal is reclaimed at
    // deadline + grace rather than hanging the pool forever.
    const clk = fakeClock(1_000_000_000_000);
    const registry = new AbortRegistry(clk.now);
    const store = new SqliteStore({ path: ":memory:" });
    closers.push(() => store.close());
    seedFanout(store);
    const ctrl = new AbortController();
    registry.register("fo", ctrl, "b1", 1_000);
    clk.advance(10_000); // past the 1000ms backstop + 500ms grace

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
      nodeLeakGraceMs: 500,
    });

    await new Promise((r) => setTimeout(r, 20));
    try {
      expect(ctrl.signal.aborted).toBe(true); // the runaway branch is reclaimed
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

  // Regression: a resume that woke a paused run is left UNAPPLIED by the
  // wake-pending sweeper (so the next dispatch's fold can still process
  // earlier hitched-along intents). It must NOT trip the resumed handler —
  // that produced the production bug where every clean resume aborted the
  // in-flight call (cause:"aborted", tokens=0) and respawned the node
  // `resumeOf:"fresh"`. The run had no active handler when the resume was
  // issued, so it can never be a mid-handler control.
  test("wake-driver intent (resume) does not trip the controller", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r-resume", "sha");
    const ctrl = new AbortController();
    registry.register("r-resume", ctrl);
    store.appendIntent("r-resume", { type: "intent.resume", payload: {} });

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
      expect(onSteerCalls).toEqual([]);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  // Same class as resume: wakeHuman leaves intent.human_input unapplied for
  // the fold to consume as decision.humanInput. It must not trip either.
  test("wake-driver intent (human_input) does not trip the controller", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r-human", "sha");
    const ctrl = new AbortController();
    registry.register("r-human", ctrl);
    store.appendIntent("r-human", { type: "intent.human_input", payload: { route: "go" } });

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
    });

    await new Promise((r) => setTimeout(r, 30));
    try {
      expect(ctrl.signal.aborted).toBe(false);
    } finally {
      shutdown.abort();
      await sup.promise;
    }
  });

  // A resume that arrives in the SAME batch as a genuine mid-flight control
  // (cancel) must still trip — the cancel is real and the run is going down.
  // Guards against the filter swallowing a co-arriving abort.
  test("resume + cancel batch still trips on the cancel", async () => {
    const registry = new AbortRegistry();
    const store = makeRunningStore("r-mix", "sha");
    const ctrl = new AbortController();
    registry.register("r-mix", ctrl);
    store.appendIntent("r-mix", { type: "intent.resume", payload: {} });
    store.appendIntent("r-mix", { type: "intent.cancel_requested", payload: {} });

    const shutdown = new AbortController();
    const sup = startSupervisor({
      store,
      registry,
      pid: process.pid,
      shutdownSignal: shutdown.signal,
      tickMs: 1,
      heartbeatIntervalMs: 1_000_000,
    });

    await new Promise((r) => setTimeout(r, 30));
    try {
      expect(ctrl.signal.aborted).toBe(true);
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
