// Concurrency tests for the executor loop.
//
// Covers:
//   1. Fire-and-forget dispatch — N runs progress in parallel up to
//      maxConcurrentRuns (a serial-await executor would fail this).
//   2. Shutdown drain — the loop waits for in-flight runs to reach a
//      terminal status (within the drain budget) before returning.
//   3. Outer terminalisation — uncaught throws inside runOne land a
//      `fact.run_halted` event so the run's capacity slot is released.

import { describe, expect, test } from "bun:test";
import type * as handler from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runExecutor, runOne } from "../src/executor.ts";
import { enqueue, rig, type TestRig } from "./helpers.ts";

// Register a single handler-node graph "start -> work -> done" on the
// rig, where the `work` node sleeps for `sleepMs` then transitions to
// `__end__`. The `start` node is a start node.
function setupRun(r: TestRig, nodeName: string, sleepMs: number): void {
  r.dispatcher.register(r.workflowSha, "start", {
    kind: "start",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: nodeName, tokens: 0, costUsd: 0 }),
  });
  r.dispatcher.register(r.workflowSha, nodeName, {
    kind: "llm",
    sideEffect: "external",
    maxMs: 5_000,
    handler: async (ctx) => {
      // Sleep, but wake up immediately on abort so the shutdown-drain
      // test completes quickly.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, sleepMs);
        if (ctx.signal) {
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        }
      });
      return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 } satisfies handler.HandlerResult;
    },
  });
  r.dispatcher.register(r.workflowSha, "done", {
    kind: "exit",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
  });
}

function commonOpts(r: TestRig, shutdown: AbortSignal, maxConcurrentRuns: number) {
  return {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns,
    pollIntervalMs: 5,
    shutdownSignal: shutdown,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

describe("executor — concurrency", () => {
  test("three runs execute in parallel up to maxConcurrentRuns", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    setupRun(r, "work", 200);

    enqueue(r, "run-a", "start");
    enqueue(r, "run-b", "start");
    enqueue(r, "run-c", "start");

    const shutdown = new AbortController();
    const executor = runExecutor(commonOpts(r, shutdown.signal, 3));

    // All three should reach "running" simultaneously, well before a
    // serial executor would (serial would take ≥ 3 * 200ms = 600ms).
    const allRunning = await waitUntil(() => {
      const a = r.store.getState("run-a")?.status;
      const b = r.store.getState("run-b")?.status;
      const c = r.store.getState("run-c")?.status;
      return a === "running" && b === "running" && c === "running";
    }, 250);
    expect(allRunning).toBe(true);

    // Let the handlers complete.
    await waitUntil(() => {
      const a = r.store.getState("run-a")?.status;
      const b = r.store.getState("run-b")?.status;
      const c = r.store.getState("run-c")?.status;
      return (
        a !== "running" && a !== "queued" && b !== "running" && b !== "queued" && c !== "running" && c !== "queued"
      );
    }, 2_000);

    shutdown.abort();
    await executor;

    // Timing check: `fact.run_started` timestamps across the three runs
    // should overlap — not serialised. With 200ms handlers and three
    // concurrent runs, all three start facts land within a tight
    // window. A serial executor spaces them ~200ms apart.
    const starts = ["run-a", "run-b", "run-c"]
      .map((id) => r.store.getEvents(id).find((e) => e.type === "fact.run_started")?.ts ?? 0)
      .sort((x, y) => x - y);
    const spread = starts[starts.length - 1]! - starts[0]!;
    expect(spread).toBeLessThan(150); // serial would be ≥ 400ms

    r.store.close();
  });

  test("shutdown drains quickly when in-flight runs finish promptly", async () => {
    // Handlers complete on their own within the drain budget — the
    // executor should wait for them and return only after all settled.
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    let entered = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async () => {
        entered += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "run-a", "start");
    enqueue(r, "run-b", "start");

    const shutdown = new AbortController();
    const executor = runExecutor({
      ...commonOpts(r, shutdown.signal, 2),
      shutdownDrainMs: 2_000,
    });

    // Wait until both `work` handlers have actually entered their sleep —
    // otherwise shutdown may fire in the gap between turns, skipping the
    // handler entirely and invalidating the drain test.
    const bothEntered = await waitUntil(() => entered === 2, 1_000);
    expect(bothEntered).toBe(true);

    shutdown.abort();
    const started = Date.now();
    await executor;
    const elapsed = Date.now() - started;

    // Runs finish naturally within ~200ms; drain returns once they
    // settle, not at the full 2_000ms budget.
    expect(elapsed).toBeGreaterThanOrEqual(100); // drain actually waited
    expect(elapsed).toBeLessThan(1_500);

    // Both reached terminal via normal handler completion.
    expect(r.store.getState("run-a")?.status).not.toBe("running");
    expect(r.store.getState("run-b")?.status).not.toBe("running");

    r.store.close();
  });

  test("shutdown honors the drain timeout when handlers stall", async () => {
    // Handler deliberately ignores abort and stalls well past the drain
    // budget. The executor must still return within ~drainMs (not
    // block forever) — the subsequent daemon startupSweep will
    // requeue any runs left in `running`.
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    let handlerEntered = false;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 10_000,
      handler: async () => {
        handlerEntered = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "stuck", "start");

    const shutdown = new AbortController();
    const executor = runExecutor({
      ...commonOpts(r, shutdown.signal, 1),
      shutdownDrainMs: 300,
    });

    // Wait until the handler is ACTUALLY in its sleep — otherwise
    // shutdown may race the turn-between-nodes gap and bypass the
    // handler entirely, defeating the drain test.
    const entered = await waitUntil(() => handlerEntered, 2_000);
    expect(entered).toBe(true);

    shutdown.abort();
    const started = Date.now();
    await executor;
    const elapsed = Date.now() - started;

    // Returned at roughly the drain budget — never the full 5_000ms the
    // stalled handler would take on its own.
    expect(elapsed).toBeLessThan(1_500);
    expect(elapsed).toBeGreaterThanOrEqual(200); // drain waited, didn't short-circuit

    r.store.close();
  });

  test("uncaught exception inside runOne lands fact.run_halted", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    setupRun(r, "work", 10);

    enqueue(r, "boom", "start");
    r.store.claimNextRun(1);

    // Poison the store's getState so the FIRST getState call inside
    // runOneInner throws — this escapes the inner try/catch (which
    // only wraps spec.handler(ctx)) and is caught by the outer safety
    // net added in A.2.
    const origGetState = r.store.getState.bind(r.store);
    let armed = true;
    r.store.getState = ((id: string) => {
      if (armed && id === "boom") {
        armed = false;
        throw new Error("induced getState crash");
      }
      return origGetState(id);
    }) as typeof r.store.getState;

    const shutdown = new AbortController();
    let caught: unknown = null;
    try {
      await runOne("boom", commonOpts(r, shutdown.signal, 1));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/induced getState crash/);

    // Restore and verify the outer catch wrote a halt fact.
    r.store.getState = origGetState;
    const events = r.store.getEvents("boom");
    const halt = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect(halt).not.toBeUndefined();
    const payload = halt!.payload as { reason: string; detail: string };
    expect(payload.reason).toBe("error");
    expect(payload.detail).toMatch(/executor crashed/);

    // Capacity slot released — status is "halted", not "running".
    expect(r.store.getState("boom")?.status).toBe("halted");

    r.store.close();
  });

  test("outer-crash halt detail names the node that was executing", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = rig({ yaml });
    setupRun(r, "work", 10);

    enqueue(r, "boom", "start");
    r.store.claimNextRun(1);

    // Let the run advance to the `work` node, then crash inside the
    // dispatch path — by which point `current_node` is pinned to
    // `work`, so the outer safety net can read it and name it.
    const origGet = r.dispatcher.get.bind(r.dispatcher);
    r.dispatcher.get = ((sha: string, nodeId: string) => {
      if (nodeId === "work") throw new Error("induced dispatch crash");
      return origGet(sha, nodeId);
    }) as typeof r.dispatcher.get;

    const shutdown = new AbortController();
    let caught: unknown = null;
    try {
      await runOne("boom", commonOpts(r, shutdown.signal, 1));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/induced dispatch crash/);

    r.dispatcher.get = origGet;
    const events = r.store.getEvents("boom");
    const halt = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect(halt).not.toBeUndefined();
    const payload = halt!.payload as { reason: string; detail: string };
    expect(payload.reason).toBe("error");
    expect(payload.detail).toMatch(/executor crashed at work/);
    expect(payload.detail).toMatch(/induced dispatch crash/);

    expect(r.store.getState("boom")?.status).toBe("halted");

    r.store.close();
  });
});
