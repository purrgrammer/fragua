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
        await new Promise<never>((_, reject) => {
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
