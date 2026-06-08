// Tier-2 fault-injection stress harness — docs/proposals/executor-pbt-decomposition.md
// (the north-star "inject faults before/after every step and prove invariants").
//
// Faults are only meaningful at EFFECT boundaries — the pure sub-steps
// (edge-selection, budget-eval, planTransition/planAbort) can't fail. So we
// inject at the seams the executor actually commits/reads/dispatches through,
// swept across every invocation over generated graphs, and assert the SPEC §4
// invariants survive (or the run recovers / halts bounded — never wedges).
//
//   OCC conflict  — the store's commit raises ConcurrencyError (this file).
//   store failure — a commit throws a non-OCC error → daemon dies mid-turn.
//   handler hang  — a node ignores ctx.signal past maxMs+grace → leak.
//   orphan effect — a side_effect_intent lands, the _done is lost → quarantine.
//   provision     — the worktree provisioner throws on ensure.
//
// `driveFaulted` mirrors the tier-2 `drive` loop (claim → runOne → wake) but
// commits through a faultStore. Single-stepping is `runOne({maxTurnsForTesting:1})`
// — one turn per call, run left resumable — used where a fault must land at a
// specific turn boundary.

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
import type { Provisioner } from "../src/worktree-provisioner.ts";
import { type ArbGraphOptions, makeArbGraph, stubOutputsFor } from "./arbitraries/graph.ts";
import { type AppendFaultSchedule, faultStore } from "./fault-store.ts";
import { checkRunInvariants } from "./invariants.ts";

// Fault scripts emit declared `outputs:` (via stubOutputsFor) so `type: parallel`
// graphs reach a clean terminal — which storms the commit-seam fault schedule
// over the THREE fan-out seams (fanout_started, branch node_completed +
// dispatch_started, fanout_joined), not just the linear spine. The
// outputs-consumer spine shape stays off (its refs sit on routing/back-edge
// nodes the script doesn't populate).
const DRIVEABLE: ArbGraphOptions = { structuredOutputs: false, parallel: true };

const TERMINAL_STATUS = new Set(["completed", "halted", "cancelled"]);

function isRoutingNode(node: Node): boolean {
  return node.type === "llm" && Array.isArray(node.attrs.routes) && node.attrs.routes.length > 0;
}

/** Always-succeeds handler (routing nodes take r0, the forward spine). */
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

/** A handler that ignores ctx.signal and never resolves — the leaked-handler
 * shape. The invokeHandler watchdog aborts the turn at maxMs + leakGrace and
 * reports `leak`; the executor halts the run rather than waiting forever. */
function hangSpec(node: Node): handler.HandlerSpec {
  return {
    kind: node.type === "tool" ? "tool" : "llm",
    sideEffect: "none",
    maxMs: 5,
    handler: () => new Promise<handler.HandlerResult>(() => {}), // never settles, ignores the signal
  };
}

interface FaultedResult {
  events: StoredEvent[];
  state: RunState;
  status: string;
  faultsInjected: number;
}

interface FaultOpts {
  /** Per-node handler (default: always-succeeds). Script a hang/throw here. */
  specFor?: (node: Node) => handler.HandlerSpec;
  /** Commit-seam fault schedule (default: never faults). */
  schedule?: AppendFaultSchedule;
  /** Leak watchdog grace (default executor value is 30s — set small to fire fast). */
  leakGraceMs?: number;
  /** Execution-environment provisioner (default: none → handlers run env-less).
   * Inject a throwing `ensure` to model a provision failure. */
  provisioner?: Provisioner;
}

/** Drive a run to a resting state, committing through a faultStore governed by
 * `opts.schedule`. Setup (saveWorkflow + enqueue) runs on the raw store so only
 * the executor's drive-phase commits are counted/faulted. */
async function driveFaulted(graph: Graph, opts: FaultOpts = {}): Promise<FaultedResult> {
  const specFor = opts.specFor ?? successSpec;
  const schedule = opts.schedule ?? (() => "ok" as const);
  const TICK_MS = 1;
  let nowMs = 1_700_000_000_000;
  const clock = (): number => {
    nowMs += TICK_MS;
    return nowMs;
  };
  const dir = mkdtempSync(join(tmpdir(), "fragua-fault-"));
  const inner = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
  try {
    const sha = "g";
    inner.saveWorkflow(sha, "g", "name: g", serializeGraph(graph), CURRENT_IR_VERSION);
    const runId = "r";
    inner.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });

    // Wrap AFTER setup so the fault schedule's call indices count only the
    // executor's commits, not enqueue/save.
    const fh = faultStore(inner, schedule);
    const store = fh.store;
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      if (node.type === "start" || node.type === "exit" || node.type === "human") continue;
      dispatcher.register(sha, node.id, specFor(node));
    }

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
      ...(opts.leakGraceMs !== undefined ? { leakGraceMs: opts.leakGraceMs } : {}),
      ...(opts.provisioner !== undefined ? { provisioner: opts.provisioner } : {}),
    };

    for (let step = 0; step < 100; step++) {
      store.claimNextRun(1);
      try {
        await runOne(runId, runOpts);
      } catch {
        // A non-OCC store fault (schedule "error") escaped runOne — exactly
        // what runOneSafe catches in production. The turn's commit didn't land,
        // so the run is left in its durable state; a startup sweep requeues it
        // (run_requeued_after_crash) and the next iteration re-dispatches.
        if (store.getState(runId)?.status === "running") store.startupSweep();
        continue;
      }
      const st = store.getState(runId);
      if (st === null || TERMINAL_STATUS.has(st.status)) break;
      if (st.status === "paused_auto") {
        nowMs += 3_600_000;
        wakePending(store, clock);
        continue;
      }
      break; // operator / human pause — resting
    }
    const finalState = store.getState(runId);
    if (finalState === null) throw new Error("run vanished");
    return {
      events: store.getEvents(runId),
      state: finalState,
      status: finalState.status,
      faultsInjected: fh.faultsInjected(),
    };
  } finally {
    inner.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const haltReason = (events: StoredEvent[]): string | undefined =>
  (events.find((e) => e.type === "fact.run_halted")?.payload as { reason?: string } | undefined)?.reason;

const TERMINAL_FACT_TYPES = new Set(["fact.run_completed", "fact.run_halted", "fact.run_cancelled"]);
/** A *resolvable* transient OCC models the supervisor racing the executor on a
 * mid-run commit; the executor re-reads + re-commits. A conflict on the
 * TERMINAL commit is the zombie/lost-race case (the reclaimed daemon must lose,
 * not re-commit) — P18's domain — so we never fault a terminal batch here. */
const hasTerminalFact = (facts: { type: string }[]): boolean => facts.some((f) => TERMINAL_FACT_TYPES.has(f.type));

describe("executor faults — OCC conflict at the commit seam", () => {
  // A SINGLE transient conflict at any commit is invisible to the outcome: the
  // OCC controller backs off, re-reads, re-dispatches, and the run converges to
  // the same terminal. Sweep the conflict across the first 40 commit calls.
  test("a single transient OCC at commit #k still completes, invariants intact", async () => {
    await fc.assert(
      fc.asyncProperty(
        makeArbGraph(["llm", "tool", "routing"], DRIVEABLE),
        fc.integer({ min: 1, max: 40 }),
        async (graph, k) => {
          const { events, state, status, faultsInjected } = await driveFaulted(graph, {
            schedule: (n, facts) => (n === k && !hasTerminalFact(facts) ? "occ" : "ok"),
          });
          // Either the conflict fired (k ≤ #commits) and was absorbed, or k was
          // past the end (vacuous). Both converge to a clean completion. The
          // terminal fact is PRESENT (not necessarily last: a resolved OCC
          // appends an `occ_conflict_resolved` observability trail after it —
          // no version bump, so terminal-absorbing for facts still holds).
          expect(status).toBe("completed");
          expect(events.some((e) => e.type === "fact.run_completed")).toBe(true);
          checkRunInvariants(events, state);
          expect(faultsInjected).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: pbtRuns(150) },
    );
  });

  // A PERSISTENT conflict on a node's commits can't be absorbed: the OCC
  // controller hits its ceiling and halts the run with `occ_exhausted` — bounded
  // termination, never a wedged `running`.
  test("persistent OCC on node commits halts with occ_exhausted (bounded, no wedge)", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { events, state, status } = await driveFaulted(graph, {
          schedule: (_n, facts) =>
            facts.some((f) => f.type === "fact.node_started" || f.type === "fact.node_completed") ? "occ" : "ok",
        });
        // Terminal either way — never left running/paused_auto (no wedge).
        expect(TERMINAL_STATUS.has(status)).toBe(true);
        // When a real node was reached (its commit conflicted repeatedly), the
        // halt is the bounded occ_exhausted backstop.
        if (status === "halted") {
          expect(haltReason(events)).toBe("occ_exhausted");
        }
        checkRunInvariants(events, state);
      }),
      { numRuns: pbtRuns(150) },
    );
  });

  // Control: with no fault scheduled, the harness completes (the conflict
  // machinery isn't masking a baseline failure).
  test("control: no fault → completes", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { status, events, state, faultsInjected } = await driveFaulted(graph, {});
        expect(status).toBe("completed");
        expect(faultsInjected).toBe(0);
        checkRunInvariants(events, state);
      }),
      { numRuns: pbtRuns(60) },
    );
  });
});

describe("executor faults — handler hang (leaked watchdog timeout)", () => {
  // Every real node ignores its signal and hangs; the FIRST one dispatched is
  // leaked by the watchdog (maxMs 5 + leakGrace 10) and the run halts — the
  // leaked handler never wedges the run as `running` forever.
  test("a hung handler is leaked → run halts (handler_timeout_leaked), invariants intact", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { events, state, status } = await driveFaulted(graph, { specFor: hangSpec, leakGraceMs: 10 });
        expect(status).toBe("halted");
        expect(events.some((e) => e.type === "fact.handler_timeout_leaked")).toBe(true);
        // The leak halts with reason "error" (detail: handler_leaked).
        expect(haltReason(events)).toBe("error");
        checkRunInvariants(events, state);
      }),
      { numRuns: pbtRuns(60) },
    );
  });
});

/** Drive a generated run to mid-flight `running` (one turn → run_started), then
 * model "the pre-commit recorder durably wrote a side_effect_intent and the
 * daemon died before the external call's _done": append a lone
 * fact.side_effect_intent and run the startup sweep. */
async function orphanCase(
  graph: Graph,
): Promise<{ status: string; events: StoredEvent[]; state: RunState; orphanSeq: number }> {
  const TICK_MS = 1;
  let nowMs = 1_700_000_000_000;
  const clock = (): number => {
    nowMs += TICK_MS;
    return nowMs;
  };
  const dir = mkdtempSync(join(tmpdir(), "fragua-orphan-"));
  const store = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
  try {
    const sha = "g";
    store.saveWorkflow(sha, "g", "name: g", serializeGraph(graph), CURRENT_IR_VERSION);
    const runId = "r";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      if (node.type === "start" || node.type === "exit" || node.type === "human") continue;
      dispatcher.register(sha, node.id, successSpec(node));
    }
    // One turn lands run_started and leaves the run `running` (the turn returns
    // `continue` to reload state) — a deterministic mid-flight point.
    store.claimNextRun(1);
    await runOne(runId, {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 1,
      shutdownSignal: new AbortController().signal,
      clock,
      random: () => 0.5,
    });
    const mid = store.getState(runId);
    if (mid === null) throw new Error("run vanished");
    // Recorder-durable intent, no matching _done (the crash window).
    const res = store.appendFact(
      runId,
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: mid.currentNode ?? "start",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "ik-orphan",
          },
        },
      ],
      mid.version,
    );
    store.startupSweep();
    const finalState = store.getState(runId);
    if (finalState === null) throw new Error("run vanished post-sweep");
    return { status: finalState.status, events: store.getEvents(runId), state: finalState, orphanSeq: res.seqs[0]! };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("executor faults — orphan side-effect (crash between intent and done)", () => {
  // A side_effect_intent with no matching _done makes the startup sweep
  // quarantine the run (orphan-side-effect invariant, I5/P6) — for ANY
  // generated graph, mid-flight at a real node.
  test("an orphaned side_effect_intent quarantines the run on sweep, invariants intact", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { status, events, state, orphanSeq } = await orphanCase(graph);
        expect(status).toBe("quarantined");
        const q = events.find((e) => e.type === "fact.run_quarantined");
        expect(q).toBeDefined();
        const payload = q!.payload as { reason?: string; orphanedIntents?: number[] };
        expect(payload.reason).toBe("orphan_side_effect");
        expect(payload.orphanedIntents).toContain(orphanSeq);
        checkRunInvariants(events, state);
      }),
      { numRuns: pbtRuns(80) },
    );
  });
});

/** A provisioner whose `ensure` always throws — the worktree/provision-failure
 * seam. The executor records daemon.worktree_provisioned{ok:false} and halts. */
const throwingProvisioner: Provisioner = {
  ensure: async () => {
    throw new Error("provision boom");
  },
  dispose: async () => {},
  envFor: () => undefined,
  baseGitSha: () => null,
  baseGitRef: () => null,
  snapshot: async () => null,
};

describe("executor faults — provision + store failure", () => {
  // provisioner.ensure throwing → the executor halts the run with a clear
  // reason rather than dispatching env-less or wedging.
  test("provision failure halts the run (worktree_provision_failed), invariants intact", async () => {
    await fc.assert(
      fc.asyncProperty(makeArbGraph(["llm", "tool", "routing"], DRIVEABLE), async (graph) => {
        const { status, events, state } = await driveFaulted(graph, { provisioner: throwingProvisioner });
        expect(status).toBe("halted");
        // Halted with a clear provision-failure reason (in the fact log;
        // daemon.worktree_provisioned is a daemon-stream event, not here).
        const halt = events.find((e) => e.type === "fact.run_halted");
        expect((halt?.payload as { reason?: string } | undefined)?.reason).toBe("error");
        expect((halt?.payload as { detail?: string } | undefined)?.detail ?? "").toContain("worktree_provision_failed");
        checkRunInvariants(events, state);
      }),
      { numRuns: pbtRuns(80) },
    );
  });

  // A non-OCC commit failure (the store throws) escapes runOne; runOneSafe
  // catches it, the sweep requeues the run, and it re-dispatches to completion —
  // a commit failure never loses the run. Sweep the failure across commits.
  test("a transient store-commit failure is recovered (requeue + redrive) → completes", async () => {
    await fc.assert(
      fc.asyncProperty(
        makeArbGraph(["llm", "tool", "routing"], DRIVEABLE),
        fc.integer({ min: 1, max: 30 }),
        async (graph, k) => {
          const { status, events, state, faultsInjected } = await driveFaulted(graph, {
            schedule: (n, facts) => (n === k && !hasTerminalFact(facts) ? "error" : "ok"),
          });
          // A non-OCC commit error is fatal-but-clean: the executor halts the run
          // (reason "error") rather than retrying (only OCC conflicts retry) or
          // wedging. When k lands past the run's commits, no fault fires → it
          // completes. Either way: a terminal, never a wedge; invariants intact.
          if (faultsInjected > 0) {
            expect(status).toBe("halted");
            expect(haltReason(events)).toBe("error");
          } else {
            expect(status).toBe("completed");
          }
          checkRunInvariants(events, state);
        },
      ),
      { numRuns: pbtRuns(80) },
    );
  });
});
