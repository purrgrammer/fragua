// Unit tests for the Store → RunSummary adapter's title + input picking.
// The rest of the summary (status, metrics, timing) is exercised through
// the route tests; these cases focus on the fields that were missing
// until auto-title support landed.

import { describe, expect, test } from "bun:test";
import type { RunState, StoredEvent } from "@swarm/store";
import { deriveNodeStates, deriveSelectedEdges, runStateToSummary } from "../../src/store/runs-adapter.ts";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "r1",
    version: 1,
    status: "running",
    currentNode: "n1",
    workflowSha: "wf",
    schemaVersion: 1,
    routing: {},
    metrics: {
      totalTokens: 0,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      loopCounts: {},
      models: {},
      nodeCosts: {},
    },
    nextSeq: 10,
    lastAppliedSeq: 1,
    priority: 0,
    enqueuedAt: 1_000_000,
    readyAt: 1_000_000,
    nodeStartedAt: null,
    updatedAt: 1_000_000,
    title: null,
    ...overrides,
  };
}

function ev(type: string, payload: Record<string, unknown>, ts = 1_000_100): StoredEvent {
  return { runId: "r1", seq: 0, type, writer: "daemon", payload, ts };
}

describe("runStateToSummary — title + input", () => {
  test("picks up title from run.title_generated event", () => {
    const s = makeState();
    const events: StoredEvent[] = [
      ev("fact.run_started", { startNode: "n1" }),
      ev("run.title_generated", { title: "Rename foo to bar" }),
    ];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBe("Rename foo to bar");
  });

  test("no title event → summary.title undefined", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("fact.run_started", { startNode: "n1" })];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBeUndefined();
  });

  test("multiple title events → last one wins", () => {
    const s = makeState();
    const events: StoredEvent[] = [
      ev("run.title_generated", { title: "first guess" }, 1_000_100),
      ev("run.title_generated", { title: "refined" }, 1_000_200),
    ];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBe("refined");
  });

  test("empty-string title is ignored (falls back to undefined)", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("run.title_generated", { title: "" })];
    expect(runStateToSummary(s, events, undefined).title).toBeUndefined();
  });

  test("non-string title payload is ignored", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("run.title_generated", { title: 42 })];
    expect(runStateToSummary(s, events, undefined).title).toBeUndefined();
  });

  test("input comes from routing.input when set", () => {
    const s = makeState({ routing: { input: "rename foo() to bar()" } });
    const summary = runStateToSummary(s, [], undefined);
    expect(summary.input).toBe("rename foo() to bar()");
  });

  test("missing / empty / non-string routing.input → summary.input undefined", () => {
    expect(runStateToSummary(makeState({ routing: {} }), [], undefined).input).toBeUndefined();
    expect(runStateToSummary(makeState({ routing: { input: "" } }), [], undefined).input).toBeUndefined();
    expect(runStateToSummary(makeState({ routing: { input: 42 } }), [], undefined).input).toBeUndefined();
  });
});

describe("deriveNodeStates — outcomeStatus awareness", () => {
  test("node_completed with outcomeStatus=fail → state: failed", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "lint", iteration: 0 }), seq: 1 },
      {
        ...ev("fact.node_completed", { nodeId: "lint", iteration: 0, outcomeStatus: "fail", nextNode: "done" }),
        seq: 2,
      },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes).toEqual([{ nodeId: "lint", state: "failed", lastEventSeq: 2 }]);
  });

  test("node_completed without outcomeStatus → state: completed (back-compat)", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_completed", { nodeId: "plan", iteration: 0, nextNode: "implement" }), seq: 5 },
    ];
    expect(deriveNodeStates(events)).toEqual([{ nodeId: "plan", state: "completed", lastEventSeq: 5 }]);
  });

  test("node_completed with outcomeStatus=success → state: completed", () => {
    const events: StoredEvent[] = [
      {
        ...ev("fact.node_completed", { nodeId: "verify", iteration: 0, outcomeStatus: "success", nextNode: "done" }),
        seq: 7,
      },
    ];
    expect(deriveNodeStates(events)[0]?.state).toBe("completed");
  });

  test("node_aborted → failed regardless of prior completed", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "x", iteration: 0, cause: "timeout" }), seq: 2 },
    ];
    expect(deriveNodeStates(events)[0]?.state).toBe("failed");
  });
});

describe("deriveSelectedEdges — edge.selected projection", () => {
  test("extracts (from, to) pairs in event order", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "start", to: "lint", rule: "weight" }), seq: 1 },
      {
        ...ev("edge.selected", { from: "lint", to: "done", rule: "condition", matched_condition: "outcome=fail" }),
        seq: 2,
      },
    ];
    expect(deriveSelectedEdges(events)).toEqual([
      { from: "start", to: "lint" },
      { from: "lint", to: "done" },
    ]);
  });

  test("non-edge.selected events are ignored", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: "y" }), seq: 2 },
      { ...ev("fact.run_halted", { reason: "error" }), seq: 3 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([{ from: "x", to: "y" }]);
  });

  test("drops edge.selected with non-string from/to", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: 42, to: "y" }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: null }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([]);
  });

  test("duplicates are preserved — back-edge iterations matter", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "verify", to: "fix" }), seq: 1 },
      { ...ev("edge.selected", { from: "verify", to: "fix" }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toHaveLength(2);
  });
});
