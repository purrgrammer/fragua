// Per-process leak budget — when a handler ignores its AbortSignal past
// `maxMs + leakGrace`, the executor records a leak. Once the count
// crosses `maxLeakedHandlers`, the daemon's `onLeakLimitExceeded`
// callback fires (production wires this to ctrl.abort()).

import { describe, expect, test } from "bun:test";
import type * as handler from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { makeLeakBudget, runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

type HandlerResult = handler.HandlerResult;

function leakingHandler(): {
  spec: handler.HandlerSpec;
  release: () => void;
} {
  let resolve!: (r: HandlerResult) => void;
  const pending = new Promise<HandlerResult>((r) => {
    resolve = r;
  });
  return {
    spec: {
      kind: "codergen",
      sideEffect: "external",
      // maxMs=20 + leakGrace=30 = 50ms budget before timeoutReject wins.
      maxMs: 20,
      handler: () => pending, // ignores ctx.signal entirely
    },
    release: () =>
      resolve({
        kind: "transition",
        nextNode: "__end__",
        tokens: 0,
        costUsd: 0,
      }),
  };
}

describe("executor — leak budget", () => {
  test("first leak does not fire onLeakLimitExceeded; the Nth one does, exactly once", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      hang [shape=box];
      done [shape=Msquare];
      start -> hang -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "hang", tokens: 0, costUsd: 0 }),
    });
    const releases: (() => void)[] = [];
    const { spec, release } = leakingHandler();
    releases.push(release);
    r.dispatcher.register(r.workflowSha, "hang", spec);
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    const exceededCalls: number[] = [];
    const baseOpts = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      leakGraceMs: 30,
      shutdownSignal: new AbortController().signal,
      maxLeakedHandlers: 3,
      onLeakLimitExceeded: (n: number) => {
        exceededCalls.push(n);
      },
    };

    // Drive three independent runs through the leaking node, sharing a
    // single LeakBudget so the per-process counter accumulates the way
    // it does inside runExecutor. Each run's handler dangles past the
    // 50ms budget; the executor commits fact.handler_timeout_leaked +
    // fact.run_halted and increments the budget. After the first two:
    // callback NOT fired. After the third: callback fires exactly once.
    const budget = makeLeakBudget(baseOpts);
    for (let i = 0; i < 3; i++) {
      const id = `rl${i}`;
      enqueue(r, id, "start");
      r.store.claimNextRun(1);
      await runOne(id, baseOpts, budget);
      expect(r.store.getState(id)?.status).toBe("halted");
      const types = r.store.getEvents(id).map((e) => e.type);
      expect(types).toContain("fact.handler_timeout_leaked");
    }
    expect(budget.count()).toBe(3);

    // Limit is 3; third leak crosses it → callback fires once with count=3.
    expect(exceededCalls).toEqual([3]);

    // Each leak also lands a daemon.leak_detected event scoped to its
    // run (run_id populated). counts run 1..3, ceiling=3.
    const leakEvents = r.store.getDaemonEvents().filter((e) => e.type === "daemon.leak_detected");
    expect(leakEvents.length).toBe(3);
    expect(leakEvents.map((e) => (e.payload as { count: number }).count)).toEqual([1, 2, 3]);
    for (const e of leakEvents) {
      const p = e.payload as { ceiling: number };
      expect(p.ceiling).toBe(3);
      expect(e.runId).toBeTruthy();
    }

    // Cleanup the dangling handler promise so the test runner doesn't
    // accumulate work after the test ends.
    for (const rel of releases) rel();
    r.store.close();
  });

  test("staying under the limit never fires the callback", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      hang [shape=box];
      done [shape=Msquare];
      start -> hang -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "hang", tokens: 0, costUsd: 0 }),
    });
    const { spec, release } = leakingHandler();
    r.dispatcher.register(r.workflowSha, "hang", spec);
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    const exceededCalls: number[] = [];
    const baseOpts = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      leakGraceMs: 30,
      shutdownSignal: new AbortController().signal,
      maxLeakedHandlers: 5,
      onLeakLimitExceeded: (n: number) => {
        exceededCalls.push(n);
      },
    };

    const budget = makeLeakBudget(baseOpts);
    for (let i = 0; i < 2; i++) {
      const id = `rl-under${i}`;
      enqueue(r, id, "start");
      r.store.claimNextRun(1);
      await runOne(id, baseOpts, budget);
    }
    expect(exceededCalls).toEqual([]);
    expect(budget.count()).toBe(2);

    release();
    r.store.close();
  });

  test("ExecutorOpts.clock pins the fact.handler_timeout_leaked payload's leakedAt", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      hang [shape=box];
      done [shape=Msquare];
      start -> hang -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "hang", tokens: 0, costUsd: 0 }),
    });
    const { spec, release } = leakingHandler();
    r.dispatcher.register(r.workflowSha, "hang", spec);
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "rl-clock", "start");
    r.store.claimNextRun(1);
    const FROZEN = 1_700_000_000_000;
    await runOne("rl-clock", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      leakGraceMs: 30,
      shutdownSignal: new AbortController().signal,
      clock: () => FROZEN,
    });

    const leak = r.store.getEvents("rl-clock").find((e) => e.type === "fact.handler_timeout_leaked");
    expect(leak).toBeDefined();
    expect((leak!.payload as { leakedAt: number }).leakedAt).toBe(FROZEN);

    release();
    r.store.close();
  });
});
