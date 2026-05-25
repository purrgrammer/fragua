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
import { CURRENT_IR_VERSION, type Graph, type Node, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { SqliteStore, type StoredEvent } from "@fragua/store";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { makeArbGraph } from "./arbitraries/graph.ts";

const TERMINAL_FACTS = new Set(["fact.run_completed", "fact.run_halted", "fact.run_cancelled", "fact.run_quarantined"]);
const TERMINAL_STATUS = new Set(["completed", "halted", "cancelled"]);
const AUTO_PAUSE_REASONS = new Set(["provider_retry", "handler_retry", "timeout_retry"]);

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
      return result;
    },
  };
}

interface DriveResult {
  events: StoredEvent[];
  status: string;
}

/** Drive a run to a resting state: terminal, or an operator pause. paused_auto
 * is woken (clock advanced past the backoff) and re-run. */
async function drive(graph: Graph, specFor: (node: Node) => handler.HandlerSpec, maxSteps = 100): Promise<DriveResult> {
  const store = new SqliteStore({ path: ":memory:" });
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

    let nowMs = 1_700_000_000_000;
    const clock = () => nowMs;
    const opts = {
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

    for (let step = 0; step < maxSteps; step++) {
      store.claimNextRun(1);
      await runOne(runId, opts);
      const st = store.getState(runId);
      if (st === null || TERMINAL_STATUS.has(st.status)) break;
      if (st.status === "paused_auto") {
        nowMs += 3_600_000; // past any backoff so wakeAutoResume fires
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
    return { events: store.getEvents(runId), status: store.getState(runId)?.status ?? "unknown" };
  } finally {
    store.close();
  }
}

function assertCoreInvariants(events: StoredEvent[]): void {
  // B — at most one terminal fact, and if present it is the last event.
  const terminals = events.filter((e) => TERMINAL_FACTS.has(e.type));
  expect(terminals.length).toBeLessThanOrEqual(1);
  if (terminals.length === 1) expect(TERMINAL_FACTS.has(events.at(-1)?.type ?? "")).toBe(true);

  // C — per-run seq strictly increasing (the log is totally ordered).
  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
  }

  // D — one node runs at a time: never two node_started without an intervening
  // node_completed (holds across retries: each dispatch is started…completed).
  let running = false;
  for (const e of events) {
    if (e.type === "fact.node_started") {
      expect(running).toBe(false);
      running = true;
    } else if (e.type === "fact.node_completed") {
      running = false;
    }
  }
}

describe("driven executor — tier-2", () => {
  test("slice 1: all-success over any human-free graph completes, no pauses/aborts", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"]), async (graph) => {
        const { events, status } = await drive(graph, successSpec);
        expect(status).toBe("completed");
        expect(events.at(-1)?.type).toBe("fact.run_completed");
        assertCoreInvariants(events);
        const types = new Set(events.map((e) => e.type));
        expect(types.has("fact.node_aborted")).toBe(false);
        expect(types.has("fact.run_paused")).toBe(false);
        expect(types.has("fact.run_paused_human")).toBe(false);
      }),
      { numRuns: 150 },
    );
  });

  test("slice 2: fail/retry/provider scripts thread the auto-wake loop and settle", async () => {
    await fc.assert(
      fc.asyncProperty(
        makeArbGraph(["llm", "tool", "routing"]),
        fc.array(fc.record({ providerFails: fc.nat({ max: 5 }), retries: fc.nat({ max: 2 }) }), {
          minLength: 6,
          maxLength: 6,
        }),
        async (graph, scripts) => {
          const scriptFor = (node: Node): NodeScript =>
            scripts[Number(node.id.slice(1)) - 1] ?? { providerFails: 0, retries: 0 };
          const { events, status } = await drive(graph, (node) => scriptedSpec(node, scriptFor(node)));

          // A — the run settled (never left parked in paused_auto: those are
          // all woken; remaining paused = an operator resting state).
          expect(["completed", "halted", "paused"]).toContain(status);

          assertCoreInvariants(events);

          // E — every auto-wake pause was resumed (we woke each paused_auto).
          const autoPauses = events.filter(
            (e) =>
              e.type === "fact.run_paused" && AUTO_PAUSE_REASONS.has((e.payload as { reason?: string }).reason ?? ""),
          ).length;
          const resumes = events.filter((e) => e.type === "fact.run_resumed").length;
          expect(resumes).toBeGreaterThanOrEqual(autoPauses);
        },
      ),
      { numRuns: 150 },
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
    const { events, status } = await drive(graph, (node) =>
      node.id === "n1" ? scriptedSpec(node, { providerFails: 2, retries: 0 }) : successSpec(node),
    );
    expect(status).toBe("completed");
    const providerPauses = events.filter(
      (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "provider_retry",
    ).length;
    expect(providerPauses).toBe(2);
    expect(events.filter((e) => e.type === "fact.run_resumed").length).toBe(2);
    assertCoreInvariants(events);
  });

  test("slice 3: HITL — human pauses are answered (intent.human_input) and the run completes", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing", "human"]), async (graph) => {
        // Non-human nodes all succeed; each human gate is answered with its
        // forward route (r0). The run threads every pause and reaches exit.
        const { events, status } = await drive(graph, successSpec);
        expect(status).toBe("completed");
        expect(events.at(-1)?.type).toBe("fact.run_completed");
        assertCoreInvariants(events);
        // Every human pause was answered and resumed.
        const humanPauses = events.filter((e) => e.type === "fact.run_paused_human").length;
        const resumes = events.filter((e) => e.type === "fact.run_resumed").length;
        expect(resumes).toBeGreaterThanOrEqual(humanPauses);
      }),
      { numRuns: 150 },
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
    const { events, status } = await drive(graph, successSpec);
    expect(status).toBe("completed");
    expect(events.filter((e) => e.type === "fact.run_paused_human").length).toBe(1);
    expect(events.filter((e) => e.type === "fact.run_resumed").length).toBeGreaterThanOrEqual(1);
    assertCoreInvariants(events);
  });
});
