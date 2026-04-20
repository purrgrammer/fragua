// Unit tests for the Store → RunSummary adapter's title + input picking.
// The rest of the summary (status, metrics, timing) is exercised through
// the route tests; these cases focus on the fields that were missing
// until auto-title support landed.

import { describe, expect, test } from "bun:test";
import type { RunState, StoredEvent } from "@swarm/store";
import { runStateToSummary } from "../../src/store/runs-adapter.ts";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "r1",
    version: 1,
    status: "running",
    currentNode: "n1",
    workflowSha: "wf",
    schemaVersion: 1,
    routing: {},
    metrics: { totalTokens: 0, totalCostUsd: 0, loopCounts: {}, models: {} },
    nextSeq: 10,
    lastAppliedSeq: 1,
    priority: 0,
    enqueuedAt: 1_000_000,
    readyAt: 1_000_000,
    nodeStartedAt: null,
    updatedAt: 1_000_000,
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
