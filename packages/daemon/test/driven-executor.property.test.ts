// Tier-2 driven-executor harness — docs/proposals/executor-pbt-decomposition.md
// (Phase 7 north star).
//
// Where the tier-1 properties drive the pure planTransition in isolation, this
// drives the *real* executor (runOne) over a generated graph against a real
// in-memory store + injected clock/RNG, then asserts the SPEC §4 invariants on
// the resulting event log. The graph comes from the same validator-checked
// arbitrary (makeArbGraph); the handler is scripted. Human nodes are excluded —
// they pause awaiting a HITL intent (a later slice).
//
// `drive` is the loop: runOne runs to a terminal OR a pause and returns. For a
// `paused_auto` (provider/handler/timeout retry) the harness advances the clock
// past the backoff and `wakePending`s the run, then re-runs — exactly what the
// real executor loop does. Operator pauses (`max_retries`, `abort_loop`,
// `max_loops`, `provider_exhausted`, …) are valid resting states: a naked
// resume would re-dispatch and re-trip them, so the harness stops there.
//
//   slice 1 — all-success scripts → the run completes; no pauses/aborts.
//   slice 2 — fail/retry/provider scripts → the run threads the auto-wake loop
//             (provider_retry is the reliable path; node max_retries defaults to
//             0, so handler-retry auto-wake only fires on goal gates) and
//             settles at a terminal or an operator pause, invariants intact.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, type Graph, type Node, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { type RunState, SqliteStore, type StoredEvent } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { type ArbGraphOptions, makeArbGraph, stubOutputsFor } from "./arbitraries/graph.ts";
import { checkRunInvariants } from "./invariants.ts";

const TERMINAL_STATUS = new Set(["completed", "halted", "cancelled"]);
const AUTO_PAUSE_REASONS = new Set(["provider_retry", "handler_retry", "timeout_retry"]);

// The scripted handlers emit declared `outputs:` (via stubOutputsFor) so a
// `type: parallel` graph's join `${{ outputs.X.findings }}` consumer resolves and
// the fan-out frontier reaches a clean terminal under crash-and-replay. The
// outputs-consumer SPINE shape stays off (structuredOutputs) — its `${{...}}`
// refs sit on routing/back-edge nodes the script doesn't populate — but fan-out
// branch outputs are exactly what the scripted success emits.
const DRIVEABLE: ArbGraphOptions = { structuredOutputs: false, parallel: true };

function isRoutingNode(node: Node): boolean {
  return node.type === "llm" && Array.isArray(node.attrs.routes) && node.attrs.routes.length > 0;
}

/** Always-succeeds handler: llm/tool advance their bare success edge; a routing
 * node exits via r0 (the route the generator always points at the spine). */
function successSpec(node: Node): handler.HandlerSpec {
  return {
    kind: node.type === "tool" ? "tool" : "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      const result: handler.HandlerResult = { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      if (isRoutingNode(node)) result.route = "r0";
      const outputs = stubOutputsFor(node);
      if (outputs !== undefined) result.outputs = outputs;
      return result;
    },
  };
}

interface NodeScript {
  /** Consecutive pause_provider{429} returns before progressing (drives
   * provider_retry auto-wake; ≤5 = the provider cap, so it then succeeds). */
  providerFails: number;
  /** Consecutive outcomeStatus="retry" returns after the provider phase
   * (handler_retry auto-wake on gates; max_retries pause on plain nodes). */
  retries: number;
}

/** Scripted handler: providerFails × pause_provider, then retries × retry, then
 * success. The per-node call counter persists across re-dispatches (the run
 * re-enters the same node on each auto-wake), so the sequence is consumed. */
function scriptedSpec(node: Node, script: NodeScript): handler.HandlerSpec {
  let calls = 0;
  return {
    kind: node.type === "tool" ? "tool" : "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      const n = calls++;
      if (n < script.providerFails) {
        return { kind: "pause_provider", httpStatus: 429, provider: "p", errorMessage: "transient" };
      }
      if (n < script.providerFails + script.retries) {
        return { kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 };
      }
      const result: handler.HandlerResult = { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      if (isRoutingNode(node)) result.route = "r0";
      const outputs = stubOutputsFor(node);
      if (outputs !== undefined) result.outputs = outputs;
      return result;
    },
  };
}

interface DriveResult {
  events: StoredEvent[];
  state: RunState;
  status: string;
  /** Runs requeued by the simulated-crash startup sweep (0 = no crash). */
  requeued: number;
  /** Total injected-clock advance over the whole drive (ms). */
  clockSpanMs: number;
  /** Of `clockSpanMs`, the time jumped while paused to fire wake-pending. The
   * activeMs bound excludes it: active time ≤ non-paused elapsed. */
  jumpedMs: number;
}

/** Drive a run to a resting state: terminal, or an operator pause. paused_auto
 * is woken (clock advanced past the backoff) and re-run; paused_human is
 * answered. With `crashTurns`, the first dispatch pass is cut short (the run is
 * left mid-flight `running`, simulating a daemon crash) and a startup sweep
 * requeues it before the recovery pass — the §5 crash-recovery invariant. */
async function drive(
  graph: Graph,
  specFor: (node: Node) => handler.HandlerSpec,
  opts: { maxSteps?: number; crashTurns?: number } = {},
): Promise<DriveResult> {
  const maxSteps = opts.maxSteps ?? 100;
  // Advancing injected clock, shared by the store (fact timestamps) and the
  // executor. Because the clock steps on every read, fact-commit times move
  // forward and activeMs accumulates real, deterministic deltas. Pause-wakes
  // jump it past the backoff; that jumped time is tracked so the activeMs bound
  // excludes it (active time ≤ non-paused elapsed).
  const TICK_MS = 1;
  const T0 = 1_700_000_000_000;
  let nowMs = T0;
  let jumpedMs = 0;
  const clock = (): number => {
    nowMs += TICK_MS;
    return nowMs;
  };
  // A real on-disk store (not :memory:) so the production pragmas actually
  // engage — WAL journaling, STRICT tables, the busy-timeout — the true
  // coordination surface the executor commits against.
  const dir = mkdtempSync(join(tmpdir(), "fragua-pbt-"));
  const store = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
  try {
    const sha = "g";
    store.saveWorkflow(sha, "g", "name: g", serializeGraph(graph), CURRENT_IR_VERSION);
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      // Human nodes keep the auto-dispatcher's real human handler (yield on
      // first dispatch, route on resume); the harness answers their pause.
      if (node.type === "start" || node.type === "exit" || node.type === "human") continue;
      dispatcher.register(sha, node.id, specFor(node));
    }
    const runId = "r";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });

    const runOpts = {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 200,
      shutdownSignal: new AbortController().signal,
      clock,
      random: () => 0.5,
    };

    // Crash phase: run a bounded number of turns, then "the daemon dies" — the
    // run is left `running`. The next daemon's startup sweep requeues it
    // (fact.run_requeued_after_crash); the recovery pass below drives it on.
    let requeued = 0;
    if (opts.crashTurns !== undefined) {
      store.claimNextRun(1);
      await runOne(runId, { ...runOpts, maxTurnsForTesting: opts.crashTurns });
      if (store.getState(runId)?.status === "running") {
        requeued = store.startupSweep().requeued.length;
      }
    }

    for (let step = 0; step < maxSteps; step++) {
      store.claimNextRun(1);
      await runOne(runId, runOpts);
      const st = store.getState(runId);
      if (st === null || TERMINAL_STATUS.has(st.status)) break;
      if (st.status === "paused_auto") {
        nowMs += 3_600_000; // jump past any backoff so wakeAutoResume fires
        jumpedMs += 3_600_000;
        wakePending(store, clock);
        continue;
      }
      if (st.status === "paused_human") {
        // Answer the operator gate: pick the node's first declared route (r0,
        // which the generator always points at the forward spine) so the run
        // progresses, then wake — the genuine pause→answer→resume HITL loop.
        const pause = [...store.getEvents(runId)].reverse().find((e) => e.type === "fact.run_paused_human");
        const routes = (pause?.payload as { routes?: string[] } | undefined)?.routes ?? [];
        if (routes.length === 0) break;
        store.appendIntent(runId, { type: "intent.human_input", payload: { route: routes[0]! } });
        wakePending(store, clock);
        continue;
      }
      break; // operator pause (resting)
    }
    const finalState = store.getState(runId);
    if (finalState === null) throw new Error("run vanished from the store");
    return {
      events: store.getEvents(runId),
      state: finalState,
      status: finalState.status,
      requeued,
      clockSpanMs: nowMs - T0,
      jumpedMs,
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** activeMs is non-negative and never exceeds the non-paused elapsed time
 * (clockSpan minus the jumps spent parked) — time-of-active is conserved, never
 * double-counted, across dispatch / pause / crash cycles. */
function assertActiveMsBounded(state: RunState, clockSpanMs: number, jumpedMs: number): void {
  expect(state.metrics.activeMs).toBeGreaterThanOrEqual(0);
  expect(state.metrics.activeMs).toBeLessThanOrEqual(clockSpanMs - jumpedMs);
}

describe("driven executor — tier-2", () => {
  test("slice 1: all-success over any human-free graph completes, no pauses/aborts", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { events, state, status, clockSpanMs, jumpedMs } = await drive(graph, successSpec);
        expect(status).toBe("completed");
        expect(events.at(-1)?.type).toBe("fact.run_completed");
        checkRunInvariants(events, state);
        // A completed run dispatched ≥1 node, so activeMs accumulated; and it
        // never exceeds the non-paused elapsed time.
        expect(state.metrics.activeMs).toBeGreaterThan(0);
        assertActiveMsBounded(state, clockSpanMs, jumpedMs);
        const types = new Set(events.map((e) => e.type));
        expect(types.has("fact.node_aborted")).toBe(false);
        expect(types.has("fact.run_paused")).toBe(false);
        expect(types.has("fact.run_paused_human")).toBe(false);
      }),
      { numRuns: pbtRuns(150) },
    );
  });

  test("slice 2: fail/retry/provider scripts thread the auto-wake loop and settle", async () => {
    await fc.assert(
      fc.asyncProperty(
        makeArbGraph(["llm", "tool", "routing"], DRIVEABLE),
        fc.array(fc.record({ providerFails: fc.nat({ max: 5 }), retries: fc.nat({ max: 2 }) }), {
          minLength: 6,
          maxLength: 6,
        }),
        async (graph, scripts) => {
          const scriptFor = (node: Node): NodeScript =>
            scripts[Number(node.id.slice(1)) - 1] ?? { providerFails: 0, retries: 0 };
          const { events, state, status, clockSpanMs, jumpedMs } = await drive(graph, (node) =>
            scriptedSpec(node, scriptFor(node)),
          );

          // A — the run settled (never left parked in paused_auto: those are
          // all woken; remaining paused = an operator resting state).
          expect(["completed", "halted", "paused"]).toContain(status);

          checkRunInvariants(events, state);
          assertActiveMsBounded(state, clockSpanMs, jumpedMs);

          // E — every auto-wake pause was resumed (we woke each paused_auto).
          const autoPauses = events.filter(
            (e) =>
              e.type === "fact.run_paused" && AUTO_PAUSE_REASONS.has((e.payload as { reason?: string }).reason ?? ""),
          ).length;
          const resumes = events.filter((e) => e.type === "fact.run_resumed").length;
          expect(resumes).toBeGreaterThanOrEqual(autoPauses);
        },
      ),
      { numRuns: pbtRuns(150) },
    );
  });

  // Deterministic proof the auto-wake loop actually fires (the property's E is
  // vacuous when no node provider-fails). One node, two transient provider
  // failures, then success.
  test("slice 2 (deterministic): provider_retry auto-wakes twice, then completes", async () => {
    const graph: Graph = {
      id: "g",
      directed: true,
      attrs: {},
      nodes: {
        start: { id: "start", type: "start", attrs: { label: "start" } },
        n1: { id: "n1", type: "llm", attrs: { label: "n1" } },
        exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
      },
      edges: [
        { from: "start", to: "n1", attrs: {} },
        { from: "n1", to: "exit", attrs: {} },
      ],
    };
    const { events, state, status } = await drive(graph, (node) =>
      node.id === "n1" ? scriptedSpec(node, { providerFails: 2, retries: 0 }) : successSpec(node),
    );
    expect(status).toBe("completed");
    const providerPauses = events.filter(
      (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "provider_retry",
    ).length;
    expect(providerPauses).toBe(2);
    expect(events.filter((e) => e.type === "fact.run_resumed").length).toBe(2);
    checkRunInvariants(events, state);
  });

  test("slice 3: HITL — human pauses are answered (intent.human_input) and the run completes", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing", "human"], DRIVEABLE), async (graph) => {
        // Non-human nodes all succeed; each human gate is answered with its
        // forward route (r0). The run threads every pause and reaches exit.
        const { events, state, status } = await drive(graph, successSpec);
        expect(status).toBe("completed");
        expect(events.at(-1)?.type).toBe("fact.run_completed");
        checkRunInvariants(events, state);
        // Every human pause was answered and resumed.
        const humanPauses = events.filter((e) => e.type === "fact.run_paused_human").length;
        const resumes = events.filter((e) => e.type === "fact.run_resumed").length;
        expect(resumes).toBeGreaterThanOrEqual(humanPauses);
      }),
      { numRuns: pbtRuns(150) },
    );
  });

  // Deterministic proof the HITL loop fires (the property's graph may contain
  // no human node). start → h(human) → exit; the gate is answered via "go".
  test("slice 3 (deterministic): a human node pauses, is answered, and completes", async () => {
    const graph: Graph = {
      id: "g",
      directed: true,
      attrs: {},
      nodes: {
        start: { id: "start", type: "start", attrs: { label: "start" } },
        h: { id: "h", type: "human", attrs: { label: "h", routes: ["go"], text: "choose" } },
        exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
      },
      edges: [
        { from: "start", to: "h", attrs: {} },
        { from: "h", to: "exit", attrs: { route: "go" } },
      ],
    };
    const { events, state, status } = await drive(graph, successSpec);
    expect(status).toBe("completed");
    expect(events.filter((e) => e.type === "fact.run_paused_human").length).toBe(1);
    expect(events.filter((e) => e.type === "fact.run_resumed").length).toBeGreaterThanOrEqual(1);
    checkRunInvariants(events, state);
  });

  test("slice 4: crash mid-run + startup sweep recovers and completes", async () => {
    await fc.assert(
      fc.asyncProperty(
        makeArbGraph(["llm", "tool", "routing"], DRIVEABLE),
        fc.integer({ min: 1, max: 4 }),
        async (graph, crashTurns) => {
          const { events, state, status, requeued, clockSpanMs, jumpedMs } = await drive(graph, successSpec, {
            crashTurns,
          });
          // Recovery converges: the run still reaches a clean completion after
          // the simulated crash + requeue.
          expect(status).toBe("completed");
          expect(events.at(-1)?.type).toBe("fact.run_completed");
          checkRunInvariants(events, state);
          assertActiveMsBounded(state, clockSpanMs, jumpedMs);
          // When the crash actually fired (run was mid-flight), the sweep
          // requeued it and the recovery fact is in the log.
          if (requeued > 0) {
            expect(events.some((e) => e.type === "fact.run_requeued_after_crash")).toBe(true);
          }
        },
      ),
      { numRuns: pbtRuns(150) },
    );
  });

  // Deterministic proof the crash/recovery path fires: cut the first pass to a
  // single turn (the run is left `running`), sweep requeues it, recovery completes.
  test("slice 4 (deterministic): crash after one turn requeues, then completes", async () => {
    const graph: Graph = {
      id: "g",
      directed: true,
      attrs: {},
      nodes: {
        start: { id: "start", type: "start", attrs: { label: "start" } },
        n1: { id: "n1", type: "llm", attrs: { label: "n1" } },
        n2: { id: "n2", type: "llm", attrs: { label: "n2" } },
        exit: { id: "exit", type: "exit", attrs: { label: "exit" } },
      },
      edges: [
        { from: "start", to: "n1", attrs: {} },
        { from: "n1", to: "n2", attrs: {} },
        { from: "n2", to: "exit", attrs: {} },
      ],
    };
    const { events, state, status, requeued } = await drive(graph, successSpec, { crashTurns: 1 });
    expect(requeued).toBe(1);
    expect(events.filter((e) => e.type === "fact.run_requeued_after_crash").length).toBeGreaterThanOrEqual(1);
    expect(status).toBe("completed");
    checkRunInvariants(events, state);
  });
});
