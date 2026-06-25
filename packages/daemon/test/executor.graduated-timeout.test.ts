// Graduated-timeout contract: a wedged handler that HONORS its AbortSignal
// must be torn down by the maxMs watchdog abort and land as
// fact.node_aborted{cause:"timeout"} → timeout_retry/timeout_exhausted —
// never as fact.handler_timeout_leaked. The leak lane is reserved for
// handlers that IGNORE the signal (executor-faults hangSpec); a leak on a
// signal-honoring handler can only mean the abort never fired for that
// dispatch, which collapses the graduated sequence (abort at maxMs, leak
// only after grace) into a simultaneous abort+leak.
//
// Repro target: the 2026-06-11 incident (runs 01ktspegfd…, 01ktspxhs5…,
// 01ktspxj1x…) — three wedged provider calls leaked with NO preceding
// node_aborted, on exactly the dispatch shapes covered here: a plain linear
// node, a node dispatched right after a fan-out join, a fan-out branch, and
// a node re-dispatched by a goal-gate retarget.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { type RunState, SqliteStore, type StoredEvent } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";

const WEDGE_MAX_MS = 40;
const LEAK_GRACE_MS = 400;

/** Never settles on its own; rejects with the signal's reason as soon as the
 * abort lands — the well-behaved twin of executor-faults' hangSpec. */
function wedgeUntilAbortSpec(): handler.HandlerSpec {
  return {
    kind: "llm",
    sideEffect: "none",
    maxMs: WEDGE_MAX_MS,
    handler: (ctx) =>
      new Promise<handler.HandlerResult>((_, reject) => {
        const bail = (): void => {
          const reason = ctx.signal.reason;
          reject(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        if (ctx.signal.aborted) {
          bail();
          return;
        }
        ctx.signal.addEventListener("abort", bail, { once: true });
      }),
  };
}

function okSpec(outcomeStatus: "success" | "fail" = "success"): handler.HandlerSpec {
  return {
    kind: "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => ({ kind: "transition", outcomeStatus, tokens: 0, costUsd: 0 }),
  };
}

interface DriveResult {
  events: StoredEvent[];
  state: RunState;
}

/** Drive a YAML workflow to rest on a clock-injected store, registering the
 * given specs per node (default: instant success). Mirrors the tier-2 drive
 * loop: claim → runOne → jump the clock past auto-wake backoffs. */
async function drive(yaml: string, specs: Record<string, handler.HandlerSpec | undefined>): Promise<DriveResult> {
  const TICK_MS = 1;
  let nowMs = 1_700_000_000_000;
  const clock = (): number => {
    nowMs += TICK_MS;
    return nowMs;
  };
  const dir = mkdtempSync(join(tmpdir(), "fragua-gradtimeout-"));
  const store = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
  try {
    const graph = parseWorkflow(yaml);
    const sha = "g";
    store.saveWorkflow(sha, "g", yaml, serializeGraph(graph), CURRENT_IR_VERSION);
    const runId = "r";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      if (node.type !== "llm" && node.type !== "tool") continue;
      dispatcher.register(sha, node.id, specs[node.id] ?? okSpec());
    }

    const runOpts = {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: (async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" })) as handler.LlmCallFn,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 200,
      shutdownSignal: new AbortController().signal,
      clock,
      random: () => 0.5,
      leakGraceMs: LEAK_GRACE_MS,
    };

    const TERMINAL = new Set(["completed", "halted", "cancelled"]);
    for (let step = 0; step < 30; step++) {
      store.claimNextRun(1);
      await runOne(runId, runOpts);
      const st = store.getState(runId);
      if (st === null || TERMINAL.has(st.status)) break;
      if (st.status === "paused_auto") {
        nowMs += 3_600_000;
        wakePending(store, clock);
        continue;
      }
      break;
    }
    const state = store.getState(runId);
    if (state === null) throw new Error("run vanished");
    return { events: store.getEvents(runId), state };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const haltDetail = (events: StoredEvent[]): string | undefined =>
  (
    events.find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored")
      ?.payload as { detail?: string } | undefined
  )?.detail;
const haltReason = (events: StoredEvent[]): string | undefined =>
  (
    events.find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored")
      ?.payload as { reason?: string } | undefined
  )?.reason;

/** The contract under test, shared by every dispatch shape. */
function expectGraduated(r: DriveResult, wedgedNode: string): void {
  const leaks = r.events.filter((e) => e.type === "fact.handler_timeout_leaked");
  expect(leaks).toHaveLength(0);
  expect(haltDetail(r.events)).not.toBe("handler_leaked");
  const timeoutAborts = r.events.filter(
    (e) =>
      e.type === "fact.node_aborted" &&
      (e.payload as { cause?: string }).cause === "timeout" &&
      (e.payload as { nodeId?: string }).nodeId === wedgedNode,
  );
  expect(timeoutAborts.length).toBeGreaterThan(0);
}

describe("executor — graduated timeout (signal-honoring wedge never leaks)", () => {
  test("linear node: wedge → timeout abort chain → timeout_exhausted, no leak", async () => {
    const yaml = `name: t
steps:
  begin: { type: llm, prompt: x, next: exit }
`;
    const r = await drive(yaml, { begin: wedgeUntilAbortSpec() });
    expectGraduated(r, "begin");
    expect(r.state.status).toBe("halted");
    expect(haltReason(r.events)).toBe("timeout_exhausted");
  }, 30_000);

  test("node dispatched after a fan-out join: wedge → timeout abort, no leak", async () => {
    const yaml = `name: t
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: x, next: exit }
`;
    const r = await drive(yaml, { synth: wedgeUntilAbortSpec() });
    expectGraduated(r, "synth");
    expect(r.state.status).toBe("halted");
    expect(haltReason(r.events)).toBe("timeout_exhausted");
  }, 30_000);

  test("fan-out branch: wedge → timeout abort, sibling unaffected, no leak", async () => {
    const yaml = `name: t
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: x, next: exit }
`;
    const r = await drive(yaml, { a: wedgeUntilAbortSpec() });
    expectGraduated(r, "a");
    // Terminal shape (halt vs pause) is the branch policy's call — the
    // contract here is only that the wedge never lands in the leak lane.
  }, 30_000);

  test("goal-gate retarget re-dispatch: wedge on pass 2 → timeout abort, no leak", async () => {
    const yaml = `name: t
steps:
  impl: { type: llm, prompt: x, next: gate }
  gate: { type: llm, prompt: g, retry: impl, max-retries: 2, next: exit }
`;
    // impl succeeds on its first pass and wedges on the retarget re-dispatch;
    // the gate fails once to force exactly one §3.4 retarget.
    let implCalls = 0;
    let gateCalls = 0;
    const implSpec: handler.HandlerSpec = {
      kind: "llm",
      sideEffect: "none",
      maxMs: WEDGE_MAX_MS,
      handler: (ctx) => {
        implCalls++;
        if (implCalls === 1) {
          return Promise.resolve({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 });
        }
        return new Promise<handler.HandlerResult>((_, reject) => {
          const bail = (): void => {
            const reason = ctx.signal.reason;
            reject(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
          };
          if (ctx.signal.aborted) {
            bail();
            return;
          }
          ctx.signal.addEventListener("abort", bail, { once: true });
        });
      },
    };
    const gateSpec: handler.HandlerSpec = {
      kind: "llm",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => {
        gateCalls++;
        return {
          kind: "transition",
          outcomeStatus: gateCalls === 1 ? "fail" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    };
    const r = await drive(yaml, { impl: implSpec, gate: gateSpec });
    expect(implCalls).toBeGreaterThan(1);
    expectGraduated(r, "impl");
  }, 30_000);
});
