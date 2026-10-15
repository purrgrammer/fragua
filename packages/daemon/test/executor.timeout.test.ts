// Observability invariant: a handler aborted by its own maxMs must
// project as `fact.node_aborted { cause: "timeout" }` — not the
// generic `cause: "aborted"` path used for operator-issued aborts
// (cancel / pause / steer / shutdown).
//
// `classifyAbortCause` is the single decision point. Tests here
// exhaust the signal.reason vs thrown-error matrix so we know the
// projection stays stable under every abort origin.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { classifyAbortCause, runOne } from "../src/executor.ts";
import { armTimeout, composeAbortSignals, type DispatchSignals } from "../src/executor-helpers.ts";
import { HandlerLeakedError, IntentArrivedError } from "../src/supervisor.ts";
import { enqueue, rig } from "./helpers.ts";

interface Harness {
  steer: AbortController;
  shutdown: AbortController;
  deadline: AbortController;
  sources: DispatchSignals;
}

function harness(): Harness {
  const steer = new AbortController();
  const shutdown = new AbortController();
  const deadline = new AbortController();
  const { signal } = composeAbortSignals([steer.signal, shutdown.signal, deadline.signal]);
  return {
    steer,
    shutdown,
    deadline,
    sources: { composite: signal, steer: steer.signal, shutdown: shutdown.signal, deadlines: [deadline.signal] },
  };
}

function makeTimeoutError(): Error {
  const e = new Error("The operation timed out.");
  e.name = "TimeoutError";
  return e;
}

describe("classifyAbortCause", () => {
  test("the deadline firing → timeout", () => {
    const h = harness();
    h.deadline.abort(makeTimeoutError());
    expect(classifyAbortCause(h.sources)).toBe("timeout");
  });

  test("a TimeoutError-named steer reason → aborted (identity, not name)", () => {
    const h = harness();
    h.steer.abort(makeTimeoutError());
    expect(classifyAbortCause(h.sources)).toBe("aborted");
  });

  test("IntentArrivedError steer → aborted", () => {
    const h = harness();
    h.steer.abort(new IntentArrivedError("r", 7));
    expect(classifyAbortCause(h.sources)).toBe("aborted");
  });

  test("HandlerLeakedError steer → aborted", () => {
    const h = harness();
    h.steer.abort(new HandlerLeakedError("r", "impl"));
    expect(classifyAbortCause(h.sources)).toBe("aborted");
  });

  test("daemon shutdown → shutdown, even when a steer fired first", () => {
    const h = harness();
    h.shutdown.abort();
    expect(classifyAbortCause(h.sources)).toBe("shutdown");
    const h2 = harness();
    h2.steer.abort(new IntentArrivedError("r", 1));
    h2.shutdown.abort();
    expect(classifyAbortCause(h2.sources)).toBe("shutdown");
  });

  test("a deadline that fired first wins over a later shutdown", () => {
    const h = harness();
    h.deadline.abort(makeTimeoutError());
    h.shutdown.abort();
    expect(classifyAbortCause(h.sources)).toBe("timeout");
  });

  test("a TimeoutError thrown with no source fired classifies none", () => {
    const h = harness();
    const thrown = makeTimeoutError();
    expect(thrown.name).toBe("TimeoutError");
    expect(classifyAbortCause(h.sources)).toBe("none");
  });

  test("a real armed deadline propagated through the composite → timeout", async () => {
    const t = armTimeout(20);
    const steer = new AbortController();
    const shutdown = new AbortController();
    const { signal } = composeAbortSignals([steer.signal, shutdown.signal, t.signal]);
    const deadline = Date.now() + 500;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(signal.aborted).toBe(true);
    expect(
      classifyAbortCause({ composite: signal, steer: steer.signal, shutdown: shutdown.signal, deadlines: [t.signal] }),
    ).toBe("timeout");
  });

  test("operator abort through the composite before the deadline fires", () => {
    const t = armTimeout(500);
    const steer = new AbortController();
    const shutdown = new AbortController();
    const { signal } = composeAbortSignals([steer.signal, shutdown.signal, t.signal]);
    steer.abort(new IntentArrivedError("r", 1));
    t.disarm();
    expect(signal.aborted).toBe(true);
    expect(
      classifyAbortCause({ composite: signal, steer: steer.signal, shutdown: shutdown.signal, deadlines: [t.signal] }),
    ).toBe("aborted");
  });
});

/** Register a single workflow with a hanging llm impl node so we
 *  can drive watchdog timeouts deterministically. The impl handler
 *  rejects on AbortSignal so the executor's catch block sees a real
 *  abort, not a clean handler return. */
function registerHangingWorkflow(r: ReturnType<typeof rig>, implMaxMs: number): void {
  r.dispatcher.register(r.workflowSha, "start", {
    kind: "start",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
  });
  r.dispatcher.register(r.workflowSha, "impl", {
    kind: "llm",
    sideEffect: "external",
    maxMs: implMaxMs,
    handler: async (ctx) =>
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          ctx.signal.removeEventListener("abort", onAbort);
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      }),
  });
  r.dispatcher.register(r.workflowSha, "done", {
    kind: "exit",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
  });
}

describe("executor — timeout projects as fact.node_aborted cause=timeout", () => {
  test("hanging handler aborted by maxMs writes fact.node_aborted{cause:timeout}", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 20,
      handler: async (ctx) => {
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
    enqueue(r, "timeout-1", "start");
    await runOne("timeout-1", {
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
    const events = r.store.getEvents("timeout-1");
    const aborted = events.find(
      (e) => e.type === "fact.node_aborted" && (e.payload as { nodeId: string }).nodeId === "impl",
    );
    expect(aborted).toBeDefined();
    expect((aborted!.payload as { cause: string }).cause).toBe("timeout");
    r.store.close();
  });
});

describe("executor — watchdog timeout pause-retry", () => {
  test("first watchdog timeout pauses the run as paused_auto{reason:'timeout_retry'}", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    registerHangingWorkflow(r, 20);
    enqueue(r, "wd-1", "start");
    await runOne("wd-1", {
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

    const state = r.store.getState("wd-1");
    expect(state?.status).toBe("paused_auto");

    // node_aborted{cause:"timeout"} still lands so partial-spend metrics
    // accrue exactly as on the abort path. Same atomic write as the
    // pause fact below.
    const events = r.store.getEvents("wd-1");
    const aborted = events.find(
      (e) => e.type === "fact.node_aborted" && (e.payload as { nodeId: string }).nodeId === "impl",
    );
    expect(aborted).toBeDefined();
    expect((aborted!.payload as { cause: string }).cause).toBe("timeout");

    // run_paused{reason:"timeout_retry"} carries the retry envelope.
    const paused = events.find((e) => e.type === "fact.run_paused");
    expect(paused).toBeDefined();
    const pp = paused!.payload as {
      reason: string;
      nodeId: string;
      attempt: number;
      delayMs: number;
      resumeAt: number;
      maxAttempts: number;
      attemptedMs: number;
    };
    expect(pp.reason).toBe("timeout_retry");
    expect(pp.nodeId).toBe("impl");
    expect(pp.attempt).toBe(1);
    expect(pp.maxAttempts).toBe(3);
    expect(pp.delayMs).toBe(5_000); // 5_000 * 2^0
    expect(pp.attemptedMs).toBe(20);
    expect(pp.resumeAt).toBeGreaterThan(0);

    // routing carries the per-(nodeId) counter + auto_resume_at so
    // wake-pending re-queues at the right moment.
    expect(state?.routing["internal.timeout_retries.impl"]).toBe(1);
    expect(state?.routing["internal.auto_resume_at"]).toBe(pp.resumeAt);
    r.store.close();
  });

  test("third consecutive watchdog timeout halts with reason=timeout_exhausted", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    registerHangingWorkflow(r, 10);
    enqueue(r, "wd-3", "start");

    // Drive three timeout cycles through the executor. After each
    // pause we manually wake the run to simulate the wake-pending
    // sweeper firing once `auto_resume_at` elapses; runOne can then
    // re-dispatch the same node and time out again.
    const opts = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      leakGraceMs: 500,
      shutdownSignal: new AbortController().signal,
    };

    for (let i = 0; i < 3; i++) {
      await runOne("wd-3", opts);
      const s = r.store.getState("wd-3");
      if (s?.status === "halted") break;
      // Wake the run to drive the next dispatch.
      r.store.appendFact("wd-3", [{ type: "fact.run_resumed", payload: { fromStatus: "paused_auto" } }], s!.version);
    }

    const finalState = r.store.getState("wd-3");
    expect(finalState?.status).toBe("halted");

    const events = r.store.getEvents("wd-3");
    const halt = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect(halt).toBeDefined();
    const hp = halt!.payload as { reason: string; detail?: string };
    expect(hp.reason).toBe("timeout_exhausted");
    expect(hp.detail).toContain("3");
    expect(hp.detail).toContain("impl");

    // Pause-retry chain landed in the trail before the halt.
    const pausedRetries = events.filter(
      (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "timeout_retry",
    );
    // Two pause-retry facts (attempts 1 and 2); the third timeout
    // exhausts and halts directly without another pause.
    expect(pausedRetries.length).toBe(2);
    r.store.close();
  });

  test("watchdog timeout does NOT bump consecutiveAborts (system-initiated, not workflow-initiated)", async () => {
    // The abort-loop ceiling counts consecutive aborts to detect a
    // workflow that crashes in a loop. Watchdog timeouts are
    // system-initiated and shouldn't compound with workflow aborts —
    // they have their own per-(nodeId) cap.
    //
    // Four watchdog timeouts in a row would exceed the
    // DEFAULT_ABORT_LOOP_CEILING (=5) only if they accumulated. Since
    // they're now pause-retry paths, the ceiling never trips: the run
    // halts via timeout_exhausted at attempt 3, not via abort_loop.
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    registerHangingWorkflow(r, 10);
    enqueue(r, "wd-2", "start");
    const opts = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      leakGraceMs: 500,
      shutdownSignal: new AbortController().signal,
    };
    for (let i = 0; i < 3; i++) {
      await runOne("wd-2", opts);
      const s = r.store.getState("wd-2");
      if (s?.status === "halted") break;
      r.store.appendFact("wd-2", [{ type: "fact.run_resumed", payload: { fromStatus: "paused_auto" } }], s!.version);
    }

    const halts = r.store
      .getEvents("wd-2")
      .filter((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect(halts.length).toBe(1);
    expect((halts[0]!.payload as { reason: string }).reason).toBe("timeout_exhausted");
    r.store.close();
  });
});

describe("classifyAbortCause — properties", () => {
  test("any deadline reason, whatever its name, classifies as timeout", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 30 }), (name, msg) => {
        const h = harness();
        h.deadline.abort(Object.assign(new Error(msg), { name }));
        expect(classifyAbortCause(h.sources)).toBe("timeout");
      }),
    );
  });

  test("any steer reason, whatever its name, classifies as aborted", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (name, msg) => {
        const h = harness();
        h.steer.abort(Object.assign(new Error(msg), { name }));
        expect(classifyAbortCause(h.sources)).toBe("aborted");
      }),
    );
  });

  test("non-Error steer reasons (strings, numbers, objects) classify as aborted", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (reason) => {
          const h = harness();
          h.steer.abort(reason);
          expect(classifyAbortCause(h.sources)).toBe("aborted");
        },
      ),
    );
  });
});
