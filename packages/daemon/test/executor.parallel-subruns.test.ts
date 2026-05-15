// End-to-end test for the parallel sub-runs path (P2 of
// `docs/proposals/parallel.md`).
//
// Builds a `component → branch_a/branch_b/branch_c → tripleoctagon` DOT
// graph, enqueues a parent run, drives the executor + wake-pending until
// every run reaches a terminal status, then asserts the event-log shape
// at every interesting boundary:
//
//   - Parent's first dispatch returns `fanout_pending`; executor emits
//     `fact.fanout_started`, transitions to `running_children`, mints
//     one sub-run per branch.
//   - Each sub-run claims, dispatches its single branch node, and
//     terminates BEFORE entering the fan_in node (subgraph fence).
//   - Wake-pending emits `fact.subrun_completed` × N then
//     `fact.fanout_completed`; parent transitions back to `queued`.
//   - Parent's collect-phase dispatch reads `subRunOutcomes`, writes
//     `routing.parallel.<id>.results`, hands off to fan_in.
//   - fan_in completes normally; parent terminates successfully.

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";

const PARALLEL_DOT = `digraph G {
  start [shape=Mdiamond];
  fanout [shape=component];
  branch_a;
  branch_b;
  branch_c;
  fan_in [shape=tripleoctagon];
  done [shape=Msquare];
  start -> fanout;
  fanout -> branch_a;
  fanout -> branch_b;
  fanout -> branch_c;
  branch_a -> fan_in;
  branch_b -> fan_in;
  branch_c -> fan_in;
  fan_in -> done;
}`;

function freshHarness() {
  const store = new SqliteStore({ path: ":memory:" });
  const dispatcher = new Dispatcher();
  // Auto-dispatch covers `parallel` and `parallel.fan_in` directly.
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });
  const registry = new AbortRegistry();
  return { store, dispatcher, tools, llmCall, registry };
}

async function driveTo(harness: ReturnType<typeof freshHarness>, runId: string, maxSteps = 20): Promise<void> {
  const ac = new AbortController();
  for (let i = 0; i < maxSteps; i++) {
    wakePending(harness.store);
    const claimed = harness.store.claimNextRun(8);
    if (claimed == null) {
      const state = harness.store.getState(runId);
      if (state == null) return;
      const terminal = state.status === "completed" || state.status === "halted" || state.status === "cancelled";
      if (terminal) return;
      // Nothing claimable and not terminal → wake-pending again next loop.
      continue;
    }
    await runOne(claimed.runId, {
      store: harness.store,
      dispatcher: harness.dispatcher,
      registry: harness.registry,
      tools: harness.tools,
      llmCall: harness.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
  }
}

describe("executor — parallel sub-runs (P2)", () => {
  test("fan-out enqueues sub-runs, sub-runs dispatch + terminate, parent collects + transitions to fan_in", async () => {
    const harness = freshHarness();
    const sha = "wf_parallel_1";
    harness.store.saveWorkflow(sha, "parallel-1", PARALLEL_DOT);

    const runId = "parent_1";
    harness.store.enqueueRun({ runId, workflowSha: sha });

    await driveTo(harness, runId);

    const final = harness.store.getState(runId)!;
    expect(final.status).toBe("completed");

    const events = harness.store.getEvents(runId).map((e) => e.type);
    // Lifecycle landmarks landed in causal order.
    expect(events).toContain("fact.run_started");
    expect(events).toContain("fact.fanout_started");
    const subrunCount = events.filter((t) => t === "fact.subrun_completed").length;
    expect(subrunCount).toBe(3);
    expect(events).toContain("fact.fanout_completed");
    expect(events).toContain("fact.run_completed");

    // Sub-runs themselves all terminated.
    const fanoutStarted = harness.store.getEvents(runId).find((e) => e.type === "fact.fanout_started");
    expect(fanoutStarted).toBeDefined();
    const childIds = (fanoutStarted!.payload as { childRunIds: string[] }).childRunIds;
    expect(childIds).toHaveLength(3);
    for (const childId of childIds) {
      const child = harness.store.getState(childId);
      expect(child).not.toBeNull();
      expect(child!.status).toBe("completed");
      expect(child!.parentRunId).toBe(runId);
      // Sub-runs terminate BEFORE entering the fan_in convergence node.
      expect(child!.currentNode).not.toBe("fan_in");
    }

    // The parent's routing carries the fan_in input the fan_in handler
    // consumes.
    const results = final.routing["parallel.fanout.results"];
    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown[]).length).toBe(3);
    harness.store.close();
  });

  test("multi-node subgraph: sub-runs dispatch internal nodes before fan-in fence terminates them (P3.2)", async () => {
    const harness = freshHarness();
    const sha = "wf_parallel_multinode";
    const multiNodeDot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      branch_a;
      branch_b;
      mid_a;
      mid_b;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> branch_a;
      fanout -> branch_b;
      branch_a -> mid_a;
      branch_b -> mid_b;
      mid_a -> fan_in;
      mid_b -> fan_in;
      fan_in -> done;
    }`;
    harness.store.saveWorkflow(sha, "parallel-multinode", multiNodeDot);

    const runId = "parent_mn";
    harness.store.enqueueRun({ runId, workflowSha: sha });

    await driveTo(harness, runId, 30);

    const final = harness.store.getState(runId)!;
    expect(final.status).toBe("completed");

    const fanoutStarted = harness.store.getEvents(runId).find((e) => e.type === "fact.fanout_started");
    const childIds = (fanoutStarted!.payload as { childRunIds: string[] }).childRunIds;
    expect(childIds).toHaveLength(2);

    for (const childId of childIds) {
      const child = harness.store.getState(childId)!;
      expect(child.status).toBe("completed");
      // Sub-runs dispatched multiple nodes inside their slice — the
      // node_completed event lands once per node, so branch_a + mid_a
      // → at least 2 node_completed events on the child's own log.
      const completedCount = harness.store.getEvents(childId).filter((e) => e.type === "fact.node_completed").length;
      expect(completedCount).toBeGreaterThanOrEqual(2);
      // The sub-run terminates BEFORE entering fan_in — current_node
      // ends at the synthetic `__end__` sentinel, not at fan_in.
      expect(child.currentNode).toBe("__end__");
    }
    harness.store.close();
  });

  test("cancel propagation: cancelling parent in running_children cascades to active sub-runs", async () => {
    const harness = freshHarness();
    const sha = "wf_parallel_2";
    harness.store.saveWorkflow(sha, "parallel-2", PARALLEL_DOT);

    const runId = "parent_2";
    harness.store.enqueueRun({ runId, workflowSha: sha });

    // Drive the parent forward until it fans out, then stop.
    const ac = new AbortController();
    wakePending(harness.store);
    const claimedParent = harness.store.claimNextRun(8);
    expect(claimedParent?.runId).toBe(runId);
    await runOne(claimedParent!.runId, {
      store: harness.store,
      dispatcher: harness.dispatcher,
      registry: harness.registry,
      tools: harness.tools,
      llmCall: harness.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });

    expect(harness.store.getState(runId)!.status).toBe("running_children");

    const children = harness.store.activeChildRuns(runId);
    expect(children.length).toBe(3);

    // Emulate the server route's cascading cancel.
    for (const childId of children) {
      harness.store.appendIntent(childId, {
        type: "intent.cancel_requested",
        payload: { reason: "parent_cancelled" },
      });
    }
    harness.store.appendIntent(runId, {
      type: "intent.cancel_requested",
      payload: { reason: "operator" },
    });

    await driveTo(harness, runId);

    const final = harness.store.getState(runId)!;
    expect(final.status).toBe("cancelled");
    for (const childId of children) {
      const child = harness.store.getState(childId);
      expect(child!.status).toBe("cancelled");
    }
    harness.store.close();
  });
});
