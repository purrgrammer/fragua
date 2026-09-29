// Fan-out property matrix (ARCH §10, P28–P32) — fast-check over the generated
// `type: parallel` graphs (arbitraries/graph.ts) driving the real executor
// (runOne), with store-commit fault injection (fault-store.ts) for the OCC seam.
// The example-based versions of P28/P29 live in executor.fanout.test.ts; these
// are the generative laws pinned by invariant-coverage.test.ts.

import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, type Graph, type Node, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { deriveRunState, getFrontier, type RunState, SqliteStore, type StoredEvent } from "@fragua/store";
import fc from "fast-check";
import { pbtFaultRuns, pbtRuns } from "../../../test/pbt-runs.ts";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { arbParallelGraph, stubOutputsFor } from "./arbitraries/graph.ts";
import { type AppendFaultSchedule, faultStore } from "./fault-store.ts";

const TERMINAL = new Set(["completed", "halted", "cancelled"]);

/** Always-succeeds branch/join handler that emits its declared `outputs:`
 * (via stubOutputsFor) so the join's `${{ outputs.<branch>.findings }}` reads
 * resolve — the fan-out frontier then reaches a clean terminal. */
function successSpec(node: Node): handler.HandlerSpec {
  return {
    kind: "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      const result: handler.HandlerResult = { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
      const outputs = stubOutputsFor(node);
      if (outputs !== undefined) result.outputs = outputs;
      return result;
    },
  };
}

interface DriveOpts {
  specFor?: (node: Node) => handler.HandlerSpec;
  faultSchedule?: AppendFaultSchedule;
  crashTurns?: number;
  fanoutBranchTimeoutMs?: number;
  leakGraceMs?: number;
}

interface DriveResult {
  events: StoredEvent[];
  state: RunState;
  status: string;
  requeued: number;
}

/** Drive a generated `type: parallel` graph to a resting state against a real
 * store. `faultSchedule` faults the executor's `appendFact` (OCC seam);
 * `crashTurns` cuts the first pass short then startup-sweeps (crash recovery). */
async function driveParallel(graph: Graph, opts: DriveOpts = {}): Promise<DriveResult> {
  const store = new SqliteStore({ path: ":memory:" });
  try {
    const sha = "g";
    store.saveWorkflow(sha, "g", "name: g", serializeGraph(graph), CURRENT_IR_VERSION);
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const specFor = opts.specFor ?? successSpec;
    for (const node of Object.values(graph.nodes)) {
      if (node.type === "start" || node.type === "exit") continue;
      dispatcher.register(sha, node.id, specFor(node));
    }
    const runId = "r";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });

    const commitStore = opts.faultSchedule !== undefined ? faultStore(store, opts.faultSchedule).store : store;
    const runOpts = {
      store: commitStore,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 200,
      shutdownSignal: new AbortController().signal,
      ...(opts.fanoutBranchTimeoutMs !== undefined ? { fanoutBranchTimeoutMs: opts.fanoutBranchTimeoutMs } : {}),
      ...(opts.leakGraceMs !== undefined ? { leakGraceMs: opts.leakGraceMs } : {}),
    };

    let requeued = 0;
    if (opts.crashTurns !== undefined) {
      store.claimNextRun(1);
      await runOne(runId, { ...runOpts, store, maxTurnsForTesting: opts.crashTurns });
      if (store.getState(runId)?.status === "running") requeued = store.startupSweep().requeued.length;
    }

    for (let step = 0; step < 50; step++) {
      store.claimNextRun(1);
      await runOne(runId, runOpts);
      const st = store.getState(runId);
      if (st === null || TERMINAL.has(st.status)) break;
      if (st.status === "queued") continue;
      break; // paused resting state
    }

    const state = store.getState(runId);
    if (state === null) throw new Error("run vanished");
    return { events: store.getEvents(runId), state, status: state.status, requeued };
  } finally {
    store.close();
  }
}

function countType(events: StoredEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

/** node_completed count per branch/join node id. */
function completionsByNode(events: StoredEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "fact.node_completed") continue;
    const id = (e.payload as { nodeId?: string }).nodeId;
    if (id !== undefined) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

describe("fan-out property matrix (P28–P32)", () => {
  // invariant: P28
  test("P28 — replay-equivalence: deriveRunState(log) ≡ live; each branch runs once; joined once", async () => {
    await fc.assert(
      fc.asyncProperty(arbParallelGraph, async (graph) => {
        const { events, state, status } = await driveParallel(graph);
        expect(status).toBe("completed");
        expect(countType(events, "fact.fanout_started")).toBe(1);
        expect(countType(events, "fact.fanout_joined")).toBe(1);
        // Every branch/join node completed exactly once.
        for (const count of completionsByNode(events).values()) expect(count).toBe(1);
        // Replay is byte-equivalent to the live projection on the load-bearing
        // fields, and the frontier is cleared at the terminal.
        const replayed = deriveRunState("r", events);
        expect(replayed.status).toBe(state.status);
        expect(replayed.currentNode).toBe(state.currentNode);
        expect(getFrontier(state.routing)).toBeNull();
        expect(getFrontier(replayed.routing)).toBeNull();
      }),
      { numRuns: pbtRuns(40) },
    );
  });

  // invariant: P29
  test("P29 — crash recovery: only uncommitted sub-nodes re-run; the region converges", async () => {
    await fc.assert(
      fc.asyncProperty(arbParallelGraph, fc.integer({ min: 3, max: 6 }), async (graph, crashTurns) => {
        const { events, status, requeued } = await driveParallel(graph, { crashTurns });
        expect(status).toBe("completed");
        // Whether or not the crash landed mid-region, no branch/join node ever
        // committed a second node_completed — a completed sub-node never re-runs.
        for (const count of completionsByNode(events).values()) expect(count).toBe(1);
        expect(countType(events, "fact.fanout_joined")).toBe(1);
        expect(requeued).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: pbtRuns(40) },
    );
  });

  // invariant: P30
  test("P30 — OCC on the fan-out seams: the region still joins exactly once; replay ≡ live", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbParallelGraph,
        fc.uniqueArray(fc.integer({ min: 1, max: 24 }), { minLength: 1, maxLength: 6 }),
        async (graph, faultAt) => {
          const faults = new Set(faultAt);
          // Fault each chosen appendFact index once with an OCC conflict; the
          // executor's OCC controller retries the turn (a new call index, not
          // re-faulted), so the region still converges.
          const schedule: AppendFaultSchedule = (callIndex) => (faults.has(callIndex) ? "occ" : "ok");
          const { events, state, status } = await driveParallel(graph, { faultSchedule: schedule });
          // Either the region converged, or it halted cleanly on the OCC ceiling
          // — never left wedged in `running`.
          expect(["completed", "halted"]).toContain(status);
          if (status === "completed") {
            expect(countType(events, "fact.fanout_joined")).toBe(1);
            for (const count of completionsByNode(events).values()) expect(count).toBe(1);
          }
          const replayed = deriveRunState("r", events);
          expect(replayed.status).toBe(state.status);
          expect(replayed.currentNode).toBe(state.currentNode);
        },
      ),
      { numRuns: pbtFaultRuns(30) },
    );
  });

  // invariant: P31
  test("P31 — per-branch liveness: a hung branch leak-halts the run rather than wedging the pool", async () => {
    await fc.assert(
      fc.asyncProperty(arbParallelGraph, async (graph) => {
        // Hang the FIRST branch entry (it ignores its abort signal, never
        // resolves); every other node succeeds instantly. The branch backstop
        // must reclaim it at the deadline — the run halts, it does not hang.
        const hungEntry = (graph.nodes["fan"]?.attrs.branches as string[] | undefined)?.[0];
        expect(hungEntry).toBeDefined();
        const specFor = (node: Node): handler.HandlerSpec =>
          node.id === hungEntry
            ? { kind: "llm", sideEffect: "none", handler: () => new Promise<never>(() => {}) }
            : successSpec(node);
        const { status, events } = await driveParallel(graph, {
          specFor,
          fanoutBranchTimeoutMs: 40,
          leakGraceMs: 20,
        });
        // Settled to a terminal (not left running / not hung), via the leak-halt.
        expect(TERMINAL.has(status)).toBe(true);
        expect(status).toBe("halted");
        const halted = events.find(
          (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
        );
        expect((halted?.payload as { detail?: string } | undefined)?.detail).toBe("handler_leaked");
      }),
      { numRuns: pbtRuns(12) },
    );
  });

  // invariant: P32
  test("P32 — frontier isolation: only the four fan-out fact types change the active-node frontier", async () => {
    const FRONTIER_MUTATORS = new Set([
      "fact.fanout_started",
      "fact.dispatch_started",
      "fact.node_completed",
      "fact.fanout_joined",
    ]);
    await fc.assert(
      fc.asyncProperty(arbParallelGraph, async (graph) => {
        const { events } = await driveParallel(graph);
        // Fold prefixes: whenever the frontier changes across a fact, that fact
        // must be one of the four mutators; every other fact leaves it identical.
        let prevKey = JSON.stringify(null);
        for (let i = 0; i < events.length; i++) {
          const frontier = getFrontier(deriveRunState("r", events.slice(0, i + 1)).routing);
          const key = JSON.stringify(frontier ?? null);
          if (i > 0 && key !== prevKey) {
            expect(FRONTIER_MUTATORS.has(events[i]!.type)).toBe(true);
          }
          prevKey = key;
        }
        // Determinism (applyFact never mutates its input): folding the full log
        // twice yields an identical frontier.
        const a = JSON.stringify(getFrontier(deriveRunState("r", events).routing) ?? null);
        const b = JSON.stringify(getFrontier(deriveRunState("r", events).routing) ?? null);
        expect(a).toBe(b);
      }),
      { numRuns: pbtRuns(30) },
    );
  });
});
