// Tier-2 driven-executor harness — docs/proposals/executor-pbt-decomposition.md
// (Phase 7 north star, first slice).
//
// Where the tier-1 properties drive the pure planTransition in isolation, this
// drives the *real* executor (runOne) over a generated graph against a real
// in-memory store + injected clock/RNG, then asserts the SPEC §4 invariants on
// the resulting event log. The graph comes from the same validator-checked
// arbitrary (makeArbGraph); the handler is scripted.
//
// First slice: all-success scripts over human-free graphs. Every node succeeds,
// so the run flows forward along its success edges (llm/tool bare spine,
// routing r0 = the forward route) to exit and completes — no pauses to wake, no
// HITL intent to answer. That already exercises the full dispatch loop, edge
// selection (outcome + route cases), goal-gate evaluation at terminal, OCC
// commits, and node ordering. Next slices add fail outcomes + wake (paused_auto),
// HITL intent injection (paused_human), and fault injection (crash/OCC/hang).

import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, type Graph, type Node, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { SqliteStore, type StoredEvent } from "@fragua/store";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { makeArbGraph } from "./arbitraries/graph.ts";

/** An always-succeeds handler: llm/tool advance along their bare success edge;
 * a routing node (type llm with routes=) exits via r0 — the route the generator
 * always points at the forward spine, so the run progresses to exit. */
function successSpec(node: Node): handler.HandlerSpec {
  const isRouting = node.type === "llm" && Array.isArray(node.attrs.routes) && node.attrs.routes.length > 0;
  return {
    kind: node.type === "tool" ? "tool" : "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      const result: handler.HandlerResult = { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      if (isRouting) result.route = "r0";
      return result;
    },
  };
}

interface DriveResult {
  events: StoredEvent[];
  status: string;
}

async function driveToTerminal(graph: Graph): Promise<DriveResult> {
  const store = new SqliteStore({ path: ":memory:" });
  try {
    const sha = "g";
    store.saveWorkflow(sha, "g", "name: g", serializeGraph(graph), CURRENT_IR_VERSION);
    const dispatcher = new Dispatcher();
    // Default handlers for synthesized start/exit (and any unregistered node).
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      if (node.type === "start" || node.type === "exit") continue;
      dispatcher.register(sha, node.id, successSpec(node));
    }
    const runId = "r";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });
    store.claimNextRun(1);
    await runOne(runId, {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 200,
      shutdownSignal: new AbortController().signal,
      clock: () => 1_700_000_000_000,
      random: () => 0.5,
    });
    return { events: store.getEvents(runId), status: store.getState(runId)?.status ?? "unknown" };
  } finally {
    store.close();
  }
}

const TERMINAL_FACTS = new Set(["fact.run_completed", "fact.run_halted", "fact.run_cancelled", "fact.run_quarantined"]);

describe("driven executor — all-success runs (tier-2 slice 1)", () => {
  test("any human-free graph, all-success, completes with SPEC invariants intact", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"]), async (graph) => {
        const { events, status } = await driveToTerminal(graph);

        // A — all-success drives the run to a clean completion.
        expect(status).toBe("completed");

        // B — exactly one terminal fact, and it is the last event.
        const terminals = events.filter((e) => TERMINAL_FACTS.has(e.type));
        expect(terminals.length).toBe(1);
        expect(events.at(-1)?.type).toBe("fact.run_completed");

        // C — per-run seq is strictly increasing (the event log is totally ordered).
        for (let i = 1; i < events.length; i++) {
          expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
        }

        // D — one node runs at a time: never two node_started without an
        // intervening node_completed (causal node ordering).
        let running = false;
        for (const e of events) {
          if (e.type === "fact.node_started") {
            expect(running).toBe(false);
            running = true;
          } else if (e.type === "fact.node_completed") {
            running = false;
          }
        }

        // E — a clean all-success flow has no aborts and no pauses.
        const types = new Set(events.map((e) => e.type));
        expect(types.has("fact.node_aborted")).toBe(false);
        expect(types.has("fact.run_paused")).toBe(false);
        expect(types.has("fact.run_paused_human")).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
