// Unbounded codergen wall-clock tests — docs/proposals/codergen-unbounded-time.md.
//
// When a codergen handler spec has `maxMs: undefined` (the user wrote
// `max_ms=0` / `timeout="0"` in DOT), the executor must:
//   - NOT compose `AbortSignal.timeout(...)` into the merged ctx.signal
//   - NOT race the handler against a leak-watchdog setTimeout
//   - still abort cleanly when the steer or shutdown controller fires
// And the supervisor's stuck-node watchdog must not trip the controller.

import { describe, expect, test } from "bun:test";
import type * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { IntentArrivedError } from "../src/supervisor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("unbounded codergen — no AbortSignal.timeout fires", () => {
  test("a codergen spec with maxMs undefined does not abort a long-running handler past the 4h ceiling", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    let capturedSignal: AbortSignal | undefined;
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
      sideEffect: "external",
      // maxMs intentionally omitted — the unbounded codergen path.
      handler: async (ctx) => {
        capturedSignal = ctx.signal;
        return { kind: "transition", nextNode: "done", tokens: 1, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ub-1", "start");
    r.store.claimNextRun(1);
    await runOne("ub-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    // The handler observed a non-aborted signal (steer + shutdown only, no
    // timeout source) and completed normally — no timeout-class abort, no
    // leak fact, no halt.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
    const events = r.store.getEvents("ub-1");
    expect(events.find((e) => e.type === "fact.handler_timeout_leaked")).toBeUndefined();
    expect(events.find((e) => e.type === "fact.run_halted")).toBeUndefined();
    const aborted = events.find((e) => e.type === "fact.node_aborted");
    expect(aborted).toBeUndefined();
    const completed = events.find(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "impl",
    );
    expect(completed).toBeDefined();
    r.store.close();
  });

  test("end-to-end — max_ms=0 propagates through dispatcher to spec.maxMs undefined", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", `name: t\nsteps:\n  impl: {type: llm, prompt: x, max_ms: 0}\n`);
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(
      autoDispatcherResolver({
        store,
        codergenFactory: (_node, _next, maxMs) => {
          const spec: handler.HandlerSpec = {
            kind: "codergen",
            sideEffect: "external",
            handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
          };
          if (maxMs === "unbounded") {
            // intentionally omit — HandlerSpec.maxMs stays undefined
          } else if (typeof maxMs === "number") {
            spec.maxMs = maxMs;
          } else {
            spec.maxMs = 4 * 60 * 60 * 1000;
          }
          return spec;
        },
      }),
    );
    const spec = dispatcher.get("sha", "impl");
    expect(spec.maxMs).toBeUndefined();
    store.close();
  });
});

describe("unbounded codergen — operator + shutdown aborts still apply", () => {
  test("a codergen spec with maxMs undefined still aborts on operator cancel", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    const registry = new AbortRegistry();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    let observed = false;
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
      sideEffect: "external",
      // unbounded
      handler: async (ctx) => {
        // Trip the registry from within the handler so the merged signal
        // aborts before we resolve. Symmetric to the supervisor's
        // IntentArrivedError trip in production.
        registry.trip("ub-cancel", new IntentArrivedError("ub-cancel", 99));
        await new Promise((res) => setTimeout(res, 5));
        observed = ctx.signal.aborted;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ub-cancel", "start");
    r.store.claimNextRun(1);
    await runOne("ub-cancel", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry,
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: new AbortController().signal,
    });

    expect(observed).toBe(true);
    const events = r.store.getEvents("ub-cancel");
    const aborted = events.find(
      (e) => e.type === "fact.node_aborted" && (e.payload as { nodeId: string }).nodeId === "impl",
    );
    expect(aborted).toBeDefined();
    expect((aborted!.payload as { cause: string }).cause).toBe("aborted");
    r.store.close();
  });

  test("a codergen spec with maxMs undefined still aborts on shutdown signal", async () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    const shutdown = new AbortController();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    let observed = false;
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
      sideEffect: "external",
      handler: async (ctx) => {
        shutdown.abort();
        await new Promise((res) => setTimeout(res, 5));
        observed = ctx.signal.aborted;
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ub-shutdown", "start");
    r.store.claimNextRun(1);
    await runOne("ub-shutdown", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: shutdown.signal,
    });

    expect(observed).toBe(true);
    r.store.close();
  });
});
