import { describe, expect, test } from "bun:test";
import { ConcurrencyError, SqliteStore } from "../src/index.ts";

function rig(): SqliteStore {
  const s = new SqliteStore({ path: ":memory:" });
  s.saveWorkflow("sha", "t", "digraph{}");
  return s;
}

describe("store metrics", () => {
  test("appendIntent increments intents counter and records duration", () => {
    const s = rig();
    s.enqueueRun({ runId: "r1", workflowSha: "sha" });
    const before = s.metricsSnapshot();
    s.appendIntent("r1", { type: "intent.pause_requested", payload: {} });
    const after = s.metricsSnapshot();
    expect(after.intents).toBe(before.intents + 1);
    expect(after.writes).toBeGreaterThan(before.writes);
    expect(after.writeDurationsMs.length).toBeGreaterThan(0);
    s.close();
  });

  test("appendFact increments facts counter and advances totals", () => {
    const s = rig();
    s.enqueueRun({ runId: "r2", workflowSha: "sha" });
    const state = s.getState("r2")!;
    s.appendFact(
      "r2",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: state.workflowSha,
            schemaVersion: state.schemaVersion,
            startNode: "a",
          },
        },
      ],
      state.version,
    );
    const m = s.metricsSnapshot();
    expect(m.facts).toBe(1);
    expect(m.totalWriteMs).toBeGreaterThanOrEqual(0);
    expect(m.uptimeMs).toBeGreaterThanOrEqual(0);
    s.close();
  });

  test("OCC conflicts surface in metrics", () => {
    const s = rig();
    s.enqueueRun({ runId: "r3", workflowSha: "sha" });
    const state = s.getState("r3")!;
    const fact = {
      type: "fact.run_started" as const,
      payload: {
        workflowSha: state.workflowSha,
        schemaVersion: state.schemaVersion,
        startNode: "a",
      },
    };
    s.appendFact("r3", [fact], state.version);
    expect(() => s.appendFact("r3", [fact], state.version)).toThrow(
      ConcurrencyError,
    );
    const m = s.metricsSnapshot();
    expect(m.occConflicts).toBe(1);
    s.close();
  });

  test("p50/p99 are finite numbers after enough samples", () => {
    const s = rig();
    s.enqueueRun({ runId: "r4", workflowSha: "sha" });
    for (let i = 0; i < 20; i++) {
      s.appendIntent("r4", { type: "intent.pause_requested", payload: {} });
    }
    const m = s.metricsSnapshot();
    expect(Number.isFinite(m.p50WriteMs)).toBe(true);
    expect(Number.isFinite(m.p99WriteMs)).toBe(true);
    expect(m.p99WriteMs).toBeGreaterThanOrEqual(m.p50WriteMs);
    s.close();
  });
});
