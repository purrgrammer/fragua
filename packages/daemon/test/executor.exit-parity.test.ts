// Exit parity: every non-success handler exit (a thrown error, a watchdog
// timeout, a leaked handler, a provider pause, a daemon shutdown) is planned by
// the one `planExit` on both dispatch paths. The same failing handler run as a
// linear node and as a fan-out branch must commit the same exit facts, and in
// both every dollar the handler recorded via `cost.recorded` must fold into
// `run_state.metrics`.

import { describe, expect, test } from "bun:test";
import type * as handler from "@fragua/core/handler";
import type { StoredEvent } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

const LINEAR_YAML = `name: lin
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: work }
  work: { type: llm, prompt: x, next: exit }
`;

const FANOUT_YAML = `name: fan
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [work, ok], next: synth }
  work: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  ok: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;

type ExitCase = "throw" | "timeout" | "leak" | "provider_pause" | "shutdown";
const EXIT_CASES: ExitCase[] = ["throw", "timeout", "leak", "provider_pause", "shutdown"];

const SPEND = { cost_usd: 0.25, total_tokens: 100, input_tokens: 60, output_tokens: 40 };

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The failing `work` handler for one exit kind. Every variant records spend
 * before it fails, so a lost spend shows as a metrics shortfall. */
function failingSpec(kind: ExitCase, shutdown: AbortController): handler.HandlerSpec {
  const base = { kind: "llm", sideEffect: "external" } as const;
  switch (kind) {
    case "throw":
      return {
        ...base,
        maxMs: 1000,
        handler: async (ctx) => {
          ctx.emit("cost.recorded", SPEND);
          throw new Error("boom");
        },
      };
    case "timeout":
      return {
        ...base,
        maxMs: 30,
        handler: async (ctx) => {
          ctx.emit("cost.recorded", SPEND);
          await waitForAbort(ctx.signal);
          throw ctx.signal.reason;
        },
      };
    case "leak":
      return {
        ...base,
        maxMs: 30,
        handler: (ctx) => {
          ctx.emit("cost.recorded", SPEND);
          return new Promise<never>(() => {});
        },
      };
    case "provider_pause":
      return {
        ...base,
        maxMs: 1000,
        handler: async (ctx) => {
          ctx.emit("cost.recorded", SPEND);
          return { kind: "pause_provider", httpStatus: 400, provider: "p", errorMessage: "bad request" };
        },
      };
    case "shutdown":
      return {
        ...base,
        maxMs: 5000,
        handler: async (ctx) => {
          ctx.emit("cost.recorded", SPEND);
          shutdown.abort();
          await waitForAbort(ctx.signal);
          throw Object.assign(new Error("shutdown"), { name: "AbortError" });
        },
      };
  }
}

type Rig = ReturnType<typeof rig>;

function registerSuccess(r: Rig, id: string, nextNode?: string): void {
  r.dispatcher.register(r.workflowSha, id, {
    kind: "llm",
    sideEffect: "external",
    maxMs: 1000,
    handler: async () => ({
      kind: "transition",
      outcomeStatus: "success",
      tokens: 0,
      costUsd: 0,
      ...(nextNode !== undefined ? { nextNode } : {}),
    }),
  });
}

async function drive(r: Rig, runId: string, shutdown: AbortController = new AbortController()): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 40,
    leakGraceMs: 20,
    shutdownSignal: shutdown.signal,
  });
}

async function runCase(kind: ExitCase, topology: "linear" | "fanout"): Promise<{ r: Rig; runId: string }> {
  const r = rig({ yaml: topology === "linear" ? LINEAR_YAML : FANOUT_YAML });
  const shutdown = new AbortController();
  registerSuccess(r, "begin", topology === "linear" ? "work" : "fan");
  if (topology === "fanout") {
    registerSuccess(r, "ok");
    registerSuccess(r, "synth");
  }
  r.dispatcher.register(r.workflowSha, "work", failingSpec(kind, shutdown));
  const runId = `${topology}-${kind}`;
  enqueue(r, runId, "begin");
  await drive(r, runId, shutdown);
  return { r, runId };
}

function nodeAborted(events: StoredEvent[], nodeId: string): StoredEvent | undefined {
  return events.find((e) => e.type === "fact.node_aborted" && (e.payload as { nodeId?: string }).nodeId === nodeId);
}

/** The exit's shape: the failing node's `node_aborted.cause`, and the
 * run-parking / terminal fact (type + reason + detail) that followed it. */
interface ExitShape {
  cause: string | undefined;
  parkingType: string | undefined;
  reason: string | undefined;
  detail: string | undefined;
}

function exitShape(r: Rig, runId: string): ExitShape {
  const events = r.store.getEvents(runId);
  const aborted = nodeAborted(events, "work");
  const parking = events.find(
    (e) => (e.type === "fact.run_paused" || e.type === "fact.run_terminated") && e.seq > (aborted?.seq ?? -1),
  );
  const p = (parking?.payload ?? {}) as { reason?: string; detail?: string };
  return {
    cause: (aborted?.payload as { cause?: string } | undefined)?.cause,
    parkingType: parking?.type,
    reason: p.reason,
    detail: p.detail,
  };
}

function expectSpendFolded(r: Rig, runId: string): void {
  const recorded = r.store.getRunCostTotals(runId).costUsd;
  expect(recorded).toBeCloseTo(SPEND.cost_usd, 6);
  expect(r.store.getState(runId)!.metrics.totalCostUsd).toBeCloseTo(recorded, 6);
}

describe("exit parity — linear vs fan-out", () => {
  test.each(EXIT_CASES)("exit %s: linear and fan-out emit identical exit facts and commit all spend", async (kind) => {
    const lin = await runCase(kind, "linear");
    const fan = await runCase(kind, "fanout");
    const linShape = exitShape(lin.r, lin.runId);
    expect(linShape.cause).toBeDefined();
    expect(exitShape(fan.r, fan.runId)).toEqual(linShape);
    expectSpendFolded(lin.r, lin.runId);
    expectSpendFolded(fan.r, fan.runId);
    lin.r.store.close();
    fan.r.store.close();
  });

  test("F1: a provider pause commits the turn's spend", async () => {
    const { r, runId } = await runCase("provider_pause", "linear");
    const aborted = nodeAborted(r.store.getEvents(runId), "work");
    expect((aborted!.payload as { cause: string }).cause).toBe("provider_pause");
    expect((aborted!.payload as { partialCostUsd: number }).partialCostUsd).toBeCloseTo(SPEND.cost_usd, 6);
    expect(r.store.getState(runId)!.status).toBe("paused");
    expect(r.store.getState(runId)!.metrics.totalCostUsd).toBeGreaterThan(0);
    r.store.close();
  });

  test("F2: a leaked linear handler halts with its spend folded", async () => {
    const { r, runId } = await runCase("leak", "linear");
    const state = r.store.getState(runId)!;
    expect(state.status).toBe("halted");
    expect(state.metrics.totalCostUsd).toBeCloseTo(r.store.getRunCostTotals(runId).costUsd, 6);
    expect(state.metrics.totalCostUsd).toBeGreaterThan(0);
    r.store.close();
  });

  test("F3: a fan-out leak bail commits sibling outcomes and spend before the terminal fact", async () => {
    const r = rig({ yaml: FANOUT_YAML });
    registerSuccess(r, "begin", "fan");
    registerSuccess(r, "synth");
    r.dispatcher.register(r.workflowSha, "work", failingSpec("leak", new AbortController()));
    r.dispatcher.register(r.workflowSha, "ok", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        ctx.emit("cost.recorded", { cost_usd: 0.4, total_tokens: 10, input_tokens: 6, output_tokens: 4 });
        await waitForAbort(ctx.signal);
        throw ctx.signal.reason;
      },
    });
    enqueue(r, "f3", "begin");
    await drive(r, "f3");

    const events = r.store.getEvents("f3");
    const terminal = events.find((e) => e.type === "fact.run_terminated");
    expect((terminal!.payload as { detail?: string }).detail).toBe("handler_leaked");
    const sibling = nodeAborted(events, "ok");
    expect(sibling).toBeDefined();
    expect((sibling!.payload as { partialCostUsd: number }).partialCostUsd).toBeCloseTo(0.4, 6);
    expect(sibling!.seq).toBeLessThan(terminal!.seq);
    const state = r.store.getState("f3")!;
    expect(state.metrics.totalCostUsd).toBeCloseTo(r.store.getRunCostTotals("f3").costUsd, 6);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.65, 6);
    r.store.close();
  });

  test("F4: a throwing fan-out branch halts the run like a linear node", async () => {
    const { r, runId } = await runCase("throw", "fanout");
    const state = r.store.getState(runId)!;
    expect(state.status).toBe("halted");
    const events = r.store.getEvents(runId);
    const terminal = events.find((e) => e.type === "fact.run_terminated");
    expect((terminal!.payload as { reason?: string; detail?: string }).reason).toBe("error");
    expect((terminal!.payload as { detail?: string }).detail).toBe("boom");
    expect(
      events.some((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "abort_loop"),
    ).toBe(false);
    r.store.close();
  });

  test("F8: a timed-out fan-out branch pauses timeout_retry and exhausts to timeout_exhausted", async () => {
    const { r, runId } = await runCase("timeout", "fanout");
    let state = r.store.getState(runId)!;
    expect(state.status).toBe("paused_auto");
    const paused = r.store.getEvents(runId).find((e) => e.type === "fact.run_paused");
    expect(paused!.payload).toMatchObject({ reason: "timeout_retry", nodeId: "work", attempt: 1 });

    for (let i = 0; i < 2 && state.status === "paused_auto"; i++) {
      r.store.appendFact(runId, [{ type: "fact.run_resumed", payload: { fromStatus: "paused_auto" } }], state.version);
      await drive(r, runId);
      state = r.store.getState(runId)!;
    }

    expect(state.status).toBe("halted");
    const events = r.store.getEvents(runId);
    const terminal = events.find((e) => e.type === "fact.run_terminated");
    expect((terminal!.payload as { reason?: string }).reason).toBe("timeout_exhausted");
    expect(
      events.filter(
        (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "timeout_retry",
      ),
    ).toHaveLength(2);
    expect(state.metrics.totalCostUsd).toBeCloseTo(r.store.getRunCostTotals(runId).costUsd, 6);
    r.store.close();
  });
});
