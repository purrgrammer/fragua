// One exit path that commits spend once with bounded payloads. Each test
// reverses one probe: a lost OCC race must not re-dispatch the handler or drop
// its spend, an oversized free-text field must be clipped rather than crash the
// commit, and abort classification follows the dispatch signal that fired.

import { describe, expect, test } from "bun:test";
import type * as handler from "@fragua/core/handler";
import { type IEventStore, PayloadTooLargeError, type SqliteStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { type ExecutorOpts, runOne } from "../src/executor.ts";
import { CRASH_HALT_MINIMAL_DETAIL } from "../src/lifecycle-planner.ts";
import { faultStore } from "./fault-store.ts";
import { enqueue, rig, type TestRig } from "./helpers.ts";

const ONE_STEP_YAML = `name: one
defaults: { provider: anthropic, model: m }
steps:
  work: { type: llm, prompt: x, next: exit }
`;

const SPEND = { cost_usd: 0.25, total_tokens: 100, input_tokens: 60, output_tokens: 40, model: "m" };

function baseOpts(r: TestRig, store: IEventStore = r.store, extra: Partial<ExecutorOpts> = {}): ExecutorOpts {
  return {
    store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 20,
    leakGraceMs: 30,
    shutdownSignal: new AbortController().signal,
    ...extra,
  };
}

function proxied(inner: SqliteStore, overrides: Partial<Record<keyof IEventStore, unknown>>): IEventStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof IEventStore];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as IEventStore;
}

function payloadBytes(p: unknown): number {
  return new TextEncoder().encode(JSON.stringify(p)).length;
}

function lastOf(r: TestRig, runId: string, type: string): Record<string, unknown> | undefined {
  const evs = r.store.getEvents(runId).filter((e) => e.type === type);
  return evs[evs.length - 1]?.payload as Record<string, unknown> | undefined;
}

function recordedCost(r: TestRig, runId: string): number {
  return r.store
    .getEvents(runId)
    .filter((e) => e.type === "cost.recorded")
    .reduce((n, e) => n + ((e.payload as { cost_usd?: number }).cost_usd ?? 0), 0);
}

describe("bounded free-text payloads", () => {
  test("a 6 KB provider error parks paused_auto with a clipped message and recorded spend", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        ctx.emit("cost.recorded", SPEND);
        return { kind: "pause_provider", httpStatus: 503, provider: "anthropic", errorMessage: "E".repeat(6 * 1024) };
      },
    });
    enqueue(r, "big-provider", "start");
    r.store.claimNextRun(1);
    await runOne("big-provider", baseOpts(r));

    const state = r.store.getState("big-provider")!;
    expect(state.status).toBe("paused_auto");
    const pause = lastOf(r, "big-provider", "fact.run_paused")!;
    expect(pause["reason"]).toBe("provider_retry");
    expect(String(pause["errorMessage"])).toMatch(/clipped \d+ bytes\]$/);
    expect(payloadBytes(pause)).toBeLessThan(4096);
    expect(state.metrics.totalCostUsd).toBeCloseTo(recordedCost(r, "big-provider"), 10);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.25, 10);
  });

  test("a 10 KB crash message halts and releases the claim", async () => {
    const r = rig();
    enqueue(r, "big-crash", "start");
    r.store.claimNextRun(1);
    let reads = 0;
    const store = proxied(r.store, {
      getUnappliedIntents: (runId: string) => {
        reads++;
        if (reads > 1) throw new Error(`boom ${"c".repeat(10 * 1024)}`);
        return r.store.getUnappliedIntents(runId);
      },
    });
    await expect(runOne("big-crash", baseOpts(r, store))).rejects.toThrow(/boom/);

    const state = r.store.getState("big-crash")!;
    expect(state.status).toBe("halted");
    const halt = lastOf(r, "big-crash", "fact.run_terminated")!;
    expect(String(halt["detail"])).toMatch(/^executor crashed at /);
    expect(payloadBytes(halt)).toBeLessThan(4096);
    expect(r.store.claimNextRun(1)).toBeNull();
  });

  test("a crash halt rejected as too large falls back to the minimal detail", async () => {
    const r = rig();
    enqueue(r, "crash-fallback", "start");
    r.store.claimNextRun(1);
    let reads = 0;
    const store = proxied(r.store, {
      getUnappliedIntents: (runId: string) => {
        reads++;
        if (reads > 1) throw new Error("boom");
        return r.store.getUnappliedIntents(runId);
      },
      appendFact: (...args: Parameters<IEventStore["appendFact"]>) => {
        const [, facts] = args;
        const crash = facts.find(
          (f) =>
            f.type === "fact.run_terminated" && (f.payload as { detail?: string }).detail !== CRASH_HALT_MINIMAL_DETAIL,
        );
        if (
          crash !== undefined &&
          String((crash.payload as { detail?: string }).detail).startsWith("executor crashed")
        ) {
          throw new PayloadTooLargeError(5000, 4096);
        }
        return r.store.appendFact(...args);
      },
    });
    await expect(runOne("crash-fallback", baseOpts(r, store))).rejects.toThrow(/boom/);

    expect(r.store.getState("crash-fallback")!.status).toBe("halted");
    expect(lastOf(r, "crash-fallback", "fact.run_terminated")?.["detail"]).toBe(CRASH_HALT_MINIMAL_DETAIL);
  });
});

describe("exits commit once", () => {
  test("a steer mid-handler commits the handler result once", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    let calls = 0;
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        calls++;
        ctx.emit("cost.recorded", SPEND);
        const { seq } = r.store.appendIntent("steered", {
          type: "intent.steering_requested",
          payload: { text: "look left" },
        });
        const state = r.store.getState("steered")!;
        r.store.appendFact(
          "steered",
          [
            {
              type: "fact.steering_applied",
              payload: { intentSeq: seq, disposition: "delivered", targets: [], targetCount: 0 },
            },
          ],
          state.version,
        );
        return { kind: "transition", outcomeStatus: "success", tokens: 100, costUsd: 0.25 };
      },
    });
    enqueue(r, "steered", "work");
    r.store.claimNextRun(1);
    await runOne("steered", baseOpts(r));

    const state = r.store.getState("steered")!;
    expect(calls).toBe(1);
    expect(state.status).toBe("completed");
    expect(state.metrics.totalCostUsd).toBeCloseTo(recordedCost(r, "steered"), 10);
    expect(
      r.store
        .getEvents("steered")
        .filter((e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "work"),
    ).toHaveLength(1);
  });

  test("a leak-halt OCC loss halts without re-dispatch", async () => {
    const r = rig();
    let calls = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 20,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        calls++;
        ctx.emit("cost.recorded", SPEND);
        return new Promise<handler.HandlerResult>(() => {});
      },
    });
    enqueue(r, "leaky", "start");
    r.store.claimNextRun(1);
    let lost = 0;
    const faulted = faultStore(r.store, (_n, facts) => {
      if (lost === 0 && facts.some((f) => f.type === "fact.handler_timeout_leaked")) {
        lost++;
        return "occ";
      }
      return "ok";
    });
    await runOne("leaky", baseOpts(r, faulted.store));

    expect(lost).toBe(1);
    expect(calls).toBe(1);
    expect(r.store.getState("leaky")!.status).toBe("halted");
    expect(r.store.getEvents("leaky").filter((e) => e.type === "fact.handler_timeout_leaked")).toHaveLength(1);
    expect(r.store.getState("leaky")!.metrics.totalCostUsd).toBeCloseTo(0.25, 10);
  });
});

describe("abort classification follows the signal that fired", () => {
  function throwing(r: TestRig, err: Error): () => number {
    let calls = 0;
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        calls++;
        ctx.emit("cost.recorded", SPEND);
        throw err;
      },
    });
    return () => calls;
  }

  test("an inner TimeoutError is a thrown-error exit carrying its message", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    const calls = throwing(
      r,
      Object.assign(new Error("inner fetch timed out after 600000ms"), { name: "TimeoutError" }),
    );
    enqueue(r, "inner-timeout", "work");
    r.store.claimNextRun(1);
    await runOne("inner-timeout", baseOpts(r));

    const events = r.store.getEvents("inner-timeout");
    expect(events.some((e) => e.type === "fact.run_paused")).toBe(false);
    const aborted = events.find((e) => e.type === "fact.node_aborted")?.payload as { cause?: string };
    expect(aborted.cause).toBe("error");
    const halt = lastOf(r, "inner-timeout", "fact.run_terminated")!;
    expect(halt["reason"]).toBe("error");
    expect(String(halt["detail"])).toContain("inner fetch timed out after 600000ms");
    expect(r.store.getState("inner-timeout")!.status).toBe("halted");
    expect(calls()).toBe(1);
  });

  test("an inner AbortError with no signal fired does not end in abort_loop", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    const calls = throwing(r, Object.assign(new Error("socket aborted by peer"), { name: "AbortError" }));
    enqueue(r, "inner-abort", "work");
    r.store.claimNextRun(1);
    await runOne("inner-abort", baseOpts(r));

    const events = r.store.getEvents("inner-abort");
    expect(
      events.some((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "abort_loop"),
    ).toBe(false);
    expect(events.filter((e) => e.type === "fact.node_aborted")).toHaveLength(1);
    const halt = lastOf(r, "inner-abort", "fact.run_terminated")!;
    expect(halt["reason"]).toBe("error");
    expect(String(halt["detail"])).toContain("socket aborted by peer");
    expect(calls()).toBe(1);
  });
});

describe("reactive budget gate on both paths", () => {
  const BUDGET_HEAD = `defaults: { provider: anthropic, model: m }
budget: 1.0
budget-policy: stop
`;
  const LIN_YAML = `name: lin
${BUDGET_HEAD}steps:
  begin: { type: llm, prompt: x, next: work }
  work: { type: llm, prompt: x, next: exit }
`;
  const FAN_YAML = `name: fan
${BUDGET_HEAD}steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;
  const TICK_USD = 0.15;

  function burner(ticks: number): handler.HandlerSpec {
    return {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        for (let i = 0; i < ticks; i++) {
          await new Promise((res) => setTimeout(res, 3));
          if (ctx.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          ctx.emit("cost.recorded", { cost_usd: TICK_USD, total_tokens: 10, input_tokens: 5, output_tokens: 5 });
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 10 * ticks, costUsd: TICK_USD * ticks };
      },
    };
  }

  const free: handler.HandlerSpec = {
    kind: "llm",
    sideEffect: "external",
    maxMs: 1_000,
    handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 }),
  };

  async function spend(yaml: string, register: (r: TestRig) => void, runId: string): Promise<number> {
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "begin", free);
    register(r);
    enqueue(r, runId, "begin");
    r.store.claimNextRun(1);
    await runOne(runId, baseOpts(r, r.store, { maxTurnsForTesting: 40 }));
    const state = r.store.getState(runId)!;
    expect(state.status).toBe("halted");
    expect(lastOf(r, runId, "fact.run_terminated")?.["reason"]).toBe("budget");
    return state.metrics.totalCostUsd;
  }

  test("fan-out spend under a budget is no greater than linear spend", async () => {
    const linCost = await spend(LIN_YAML, (r) => r.dispatcher.register(r.workflowSha, "work", burner(10)), "lin");
    let synthRan = false;
    const fanCost = await spend(
      FAN_YAML,
      (r) => {
        r.dispatcher.register(r.workflowSha, "a", burner(5));
        r.dispatcher.register(r.workflowSha, "b", burner(5));
        r.dispatcher.register(r.workflowSha, "synth", {
          ...free,
          handler: async () => {
            synthRan = true;
            return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
          },
        });
      },
      "fan",
    );
    expect(linCost).toBeLessThan(TICK_USD * 10);
    expect(fanCost).toBeLessThanOrEqual(linCost + 1e-9);
    expect(synthRan).toBe(false);
  });
});
