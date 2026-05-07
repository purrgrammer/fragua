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
import { HandlerLeakedError, IntentArrivedError } from "../src/supervisor.ts";
import { enqueue, rig } from "./helpers.ts";

function abortedWith(reason: unknown): AbortSignal {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
}

function makeTimeoutError(): Error {
  const e = new Error("The operation timed out.");
  e.name = "TimeoutError";
  return e;
}

function makeAbortError(msg = "aborted"): Error {
  const e = new Error(msg);
  e.name = "AbortError";
  return e;
}

describe("classifyAbortCause", () => {
  test("TimeoutError reason → timeout", () => {
    const signal = abortedWith(makeTimeoutError());
    expect(classifyAbortCause(signal, makeAbortError())).toBe("timeout");
  });

  test("TimeoutError thrown but signal reason is intent → timeout (thrown wins tie)", () => {
    const signal = abortedWith(new IntentArrivedError("r", 5));
    const thrown = makeTimeoutError();
    expect(classifyAbortCause(signal, thrown)).toBe("timeout");
  });

  test("IntentArrivedError reason → aborted", () => {
    const signal = abortedWith(new IntentArrivedError("r", 7));
    expect(classifyAbortCause(signal, makeAbortError())).toBe("aborted");
  });

  test("HandlerLeakedError reason → aborted", () => {
    const signal = abortedWith(new HandlerLeakedError("r", "impl"));
    expect(classifyAbortCause(signal, makeAbortError())).toBe("aborted");
  });

  test("shutdown-style abort (plain Error) → aborted", () => {
    const signal = abortedWith(new Error("shutdown"));
    expect(classifyAbortCause(signal, makeAbortError())).toBe("aborted");
  });

  test("non-aborted signal → aborted (caller is in an abort branch; be defensive)", () => {
    const c = new AbortController();
    expect(classifyAbortCause(c.signal, makeAbortError())).toBe("aborted");
  });

  test("real AbortSignal.timeout propagated through AbortSignal.any", async () => {
    const timeoutSignal = AbortSignal.timeout(5);
    const ctrl = new AbortController();
    const merged = AbortSignal.any([timeoutSignal, ctrl.signal]);
    await new Promise((r) => setTimeout(r, 20));
    expect(merged.aborted).toBe(true);
    expect(classifyAbortCause(merged, makeAbortError())).toBe("timeout");
  });

  test("operator abort through AbortSignal.any before timeout fires", async () => {
    const timeoutSignal = AbortSignal.timeout(500);
    const ctrl = new AbortController();
    const merged = AbortSignal.any([timeoutSignal, ctrl.signal]);
    ctrl.abort(new IntentArrivedError("r", 1));
    expect(merged.aborted).toBe(true);
    expect(classifyAbortCause(merged, makeAbortError())).toBe("aborted");
  });
});

/** Register a single workflow with a hanging codergen impl node so we
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
    kind: "codergen",
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
    const dot = `digraph {
      start [shape=Mdiamond];
      impl [shape=box];
      done [shape=Msquare];
      start -> impl -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
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
    const dot = `digraph {
      start [shape=Mdiamond]; impl [shape=box]; done [shape=Msquare];
      start -> impl -> done;
    }`;
    const r = rig({ dot });
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
    const dot = `digraph {
      start [shape=Mdiamond]; impl [shape=box]; done [shape=Msquare];
      start -> impl -> done;
    }`;
    const r = rig({ dot });
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
    const halt = events.find((e) => e.type === "fact.run_halted");
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
    const dot = `digraph {
      start [shape=Mdiamond]; impl [shape=box]; done [shape=Msquare];
      start -> impl -> done;
    }`;
    const r = rig({ dot });
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

    const halts = r.store.getEvents("wd-2").filter((e) => e.type === "fact.run_halted");
    expect(halts.length).toBe(1);
    expect((halts[0]!.payload as { reason: string }).reason).toBe("timeout_exhausted");
    r.store.close();
  });
});

describe("classifyAbortCause — properties", () => {
  test("any Error reason with name=TimeoutError classifies as timeout", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 30 }), (msg) => {
        const err = new Error(msg);
        err.name = "TimeoutError";
        const signal = abortedWith(err);
        expect(classifyAbortCause(signal, makeAbortError())).toBe("timeout");
      }),
    );
  });

  test("any Error reason with non-TimeoutError name classifies as aborted", () => {
    const nonTimeoutName = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== "TimeoutError");
    fc.assert(
      fc.property(nonTimeoutName, fc.string({ maxLength: 20 }), (name, msg) => {
        const err = new Error(msg);
        err.name = name;
        const signal = abortedWith(err);
        expect(classifyAbortCause(signal, makeAbortError())).toBe("aborted");
      }),
    );
  });

  test("non-Error reasons (strings, numbers, objects) classify as aborted", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
        (reason) => {
          const signal = abortedWith(reason);
          expect(classifyAbortCause(signal, makeAbortError())).toBe("aborted");
        },
      ),
    );
  });
});
