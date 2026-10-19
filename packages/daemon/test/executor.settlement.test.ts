// One settlement path: every exit commits the handler's spend exactly once and
// no run is left `running` without a claimer. Each test reverses a probe that
// failed before: an OCC-exhausted result kept its spend (F1), an append failure
// released the run (F2), two halting fan-out branches both kept their spend
// (F3), a budget pause outranked an auto-retry pause (F4), and a thrown-error
// branch halt aborted its in-flight sibling (F5).

import { describe, expect, test } from "bun:test";
import type * as handler from "@fragua/core/handler";
import type { IEventStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { type ExecutorOpts, runOne } from "../src/executor.ts";
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
    maxTurnsForTesting: 40,
    leakGraceMs: 30,
    shutdownSignal: new AbortController().signal,
    ...extra,
  };
}

function recordedCost(r: TestRig, runId: string): number {
  return r.store
    .getEvents(runId)
    .filter((e) => e.type === "cost.recorded")
    .reduce((n, e) => n + ((e.payload as { cost_usd?: number }).cost_usd ?? 0), 0);
}

function lastOf(r: TestRig, runId: string, type: string): Record<string, unknown> | undefined {
  const evs = r.store.getEvents(runId).filter((e) => e.type === type);
  return evs[evs.length - 1]?.payload as Record<string, unknown> | undefined;
}

function spending(r: TestRig, nodeId: string, calls: { n: number }): void {
  r.dispatcher.register(r.workflowSha, nodeId, {
    kind: "llm",
    sideEffect: "external",
    maxMs: 1_000,
    handler: async (ctx): Promise<handler.HandlerResult> => {
      calls.n++;
      ctx.emit("cost.recorded", SPEND);
      return {
        kind: "transition",
        outcomeStatus: "success",
        tokens: 100,
        costUsd: 0.25,
        inputTokens: 60,
        outputTokens: 40,
      };
    },
  });
}

describe("linear settlement", () => {
  test("an OCC-exhausted node_completed still commits its 0.25 spend", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    const calls = { n: 0 };
    spending(r, "work", calls);
    enqueue(r, "occ-spend", "work");
    r.store.claimNextRun(1);
    const faulted = faultStore(r.store, (_n, facts) =>
      facts.some((f) => f.type === "fact.node_completed") ? "occ" : "ok",
    );
    await runOne("occ-spend", baseOpts(r, faulted.store));

    const state = r.store.getState("occ-spend")!;
    expect(state.status).toBe("halted");
    expect(lastOf(r, "occ-spend", "fact.run_terminated")?.["reason"]).toBe("occ_exhausted");
    expect(calls.n).toBe(1);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.25, 10);
    expect(state.metrics.totalCostUsd).toBeCloseTo(recordedCost(r, "occ-spend"), 10);
  });

  test("an injected non-OCC append failure releases the run instead of leaving it running", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    spending(r, "work", { n: 0 });
    enqueue(r, "append-fail", "work");
    r.store.claimNextRun(1);
    const faulted = faultStore(r.store, () => "error");
    await expect(runOne("append-fail", baseOpts(r, faulted.store))).rejects.toThrow(/injected store failure/);

    const state = r.store.getState("append-fail")!;
    expect(state.status).not.toBe("running");
    expect(r.store.getEvents("append-fail").some((e) => e.type === "fact.run_requeued_after_crash")).toBe(true);
    expect(r.store.claimNextRun(1)?.runId).toBe("append-fail");
  });

  test("a crash while committing a result halts with that result's spend", async () => {
    const r = rig({ yaml: ONE_STEP_YAML });
    spending(r, "work", { n: 0 });
    enqueue(r, "crash-spend", "work");
    r.store.claimNextRun(1);
    const faulted = faultStore(r.store, (_n, facts) =>
      facts.some((f) => f.type === "fact.node_completed") ? "error" : "ok",
    );
    await expect(runOne("crash-spend", baseOpts(r, faulted.store))).rejects.toThrow(/injected store failure/);

    const state = r.store.getState("crash-spend")!;
    expect(state.status).toBe("halted");
    expect(String(lastOf(r, "crash-spend", "fact.run_terminated")?.["detail"])).toMatch(/^executor crashed at /);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.25, 10);
  });
});

const FAN_HEAD = `defaults: { provider: anthropic, model: m }
`;

function fanYaml(name: string, extraHead = ""): string {
  return `name: ${name}
${FAN_HEAD}${extraHead}steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;
}

const free: handler.HandlerSpec = {
  kind: "llm",
  sideEffect: "external",
  maxMs: 1_000,
  handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 }),
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

async function untilAborted(signal: AbortSignal, capMs: number): Promise<boolean> {
  const start = Date.now();
  while (!signal.aborted && Date.now() - start < capMs) await sleepMs(2);
  return signal.aborted;
}

async function driveFan(r: TestRig, runId: string, extra: Partial<ExecutorOpts> = {}): Promise<void> {
  r.dispatcher.register(r.workflowSha, "begin", free);
  r.dispatcher.register(r.workflowSha, "synth", free);
  enqueue(r, runId, "begin");
  r.store.claimNextRun(1);
  await runOne(runId, baseOpts(r, r.store, { leakGraceMs: 500, ...extra }));
}

describe("fan-out settlement", () => {
  test("two halting fan-out branches commit both branches' spend", async () => {
    const r = rig({ yaml: fanYaml("halts") });
    for (const id of ["a", "b"]) {
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1_000,
        handler: async (ctx): Promise<handler.HandlerResult> => {
          ctx.emit("cost.recorded", { cost_usd: 0.15, total_tokens: 10, input_tokens: 5, output_tokens: 5 });
          await sleepMs(5);
          return { kind: "halt", reason: "error", detail: `${id} gave up` };
        },
      });
    }
    await driveFan(r, "two-halts");

    const state = r.store.getState("two-halts")!;
    expect(state.status).toBe("halted");
    expect(recordedCost(r, "two-halts")).toBeCloseTo(0.3, 10);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.3, 10);
  });

  test("a budget pause beats a timeout_retry pause settled first", async () => {
    const r = rig({ yaml: fanYaml("prec", "budget: 1.0\nbudget-policy: pause\n") });
    r.dispatcher.register(r.workflowSha, "a", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 20,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        await untilAborted(ctx.signal, 2_000);
        throw abortError();
      },
    });
    r.dispatcher.register(r.workflowSha, "b", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        await sleepMs(120);
        ctx.emit("cost.recorded", { cost_usd: 1.05, total_tokens: 10, input_tokens: 5, output_tokens: 5 });
        if (await untilAborted(ctx.signal, 50)) throw abortError();
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 1.05 };
      },
    });
    await driveFan(r, "budget-wins");

    const state = r.store.getState("budget-wins")!;
    const events = r.store.getEvents("budget-wins");
    const timeoutAt = events.findIndex(
      (e) => e.type === "fact.node_aborted" && (e.payload as { cause?: string }).cause === "timeout",
    );
    const pauses = events
      .filter((e) => e.type === "fact.run_paused")
      .map((e) => (e.payload as { reason: string }).reason);
    expect(timeoutAt).toBeGreaterThanOrEqual(0);
    expect(pauses).toContain("budget");
    expect(pauses).not.toContain("timeout_retry");
    expect(state.status).toBe("paused");
    expect(state.metrics.totalCostUsd).toBeCloseTo(1.05, 10);
  });

  test("a thrown-error branch halt aborts its in-flight sibling", async () => {
    const r = rig({ yaml: fanYaml("sib") });
    r.dispatcher.register(r.workflowSha, "a", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        ctx.emit("cost.recorded", { cost_usd: 0.1, total_tokens: 10, input_tokens: 5, output_tokens: 5 });
        await sleepMs(10);
        throw new Error("branch a exploded");
      },
    });
    let siblingSawAbort = false;
    r.dispatcher.register(r.workflowSha, "b", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5_000,
      handler: async (ctx): Promise<handler.HandlerResult> => {
        ctx.emit("cost.recorded", { cost_usd: 0.5, total_tokens: 10, input_tokens: 5, output_tokens: 5 });
        if (await untilAborted(ctx.signal, 300)) {
          siblingSawAbort = true;
          throw abortError();
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.5 };
      },
    });
    await driveFan(r, "sibling-abort");

    const state = r.store.getState("sibling-abort")!;
    const events = r.store.getEvents("sibling-abort");
    expect(siblingSawAbort).toBe(true);
    expect(
      events.some((e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "b"),
    ).toBe(false);
    expect(state.status).toBe("halted");
    expect(lastOf(r, "sibling-abort", "fact.run_terminated")?.["detail"]).toBe("branch a exploded");
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.6, 10);
    expect(state.metrics.totalCostUsd).toBeCloseTo(recordedCost(r, "sibling-abort"), 10);
  });
});
