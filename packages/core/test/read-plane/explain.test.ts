// Tests for the pure `buildExplanation` projection in `read-plane/explain.ts`.
// Uses synthetic event streams — no store, no I/O.

import { describe, expect, test } from "bun:test";
import { buildExplanation } from "../../src/read-plane/explain.ts";
import type { RunDetail } from "../../src/read-plane/schemas.ts";
import type { SnapshotItem } from "../../src/read-plane/snapshots.ts";
import type { StepSnapshot } from "../../src/read-plane/steps.ts";

function baseDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "r1",
    status: "success",
    runStatus: "completed",
    startedAt: new Date().toISOString(),
    lastEventSeq: 0,
    nodes: [],
    selectedEdges: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    projectId: "p1",
    projectName: "test",
    ...overrides,
  };
}

describe("read-plane explain", () => {
  test("absent-run guard: buildExplanation still works with minimal inputs", () => {
    const exp = buildExplanation(baseDetail(), [], [], []);
    expect(exp.runId).toBe("r1");
    expect(exp.path).toEqual([]);
    expect(exp.steps).toEqual([]);
    expect(exp.snapshots).toEqual([]);
    expect(exp.diffSummary).toBeNull();
    expect(exp.outcome.kind).toBe("running");
    expect(exp.budgetWarnings).toEqual([]);
  });

  test("traversed path mirrors edge.selected order", () => {
    const detail = baseDetail({
      selectedEdges: [
        { from: "start", to: "n1", iteration: 0 },
        { from: "n1", to: "n2", iteration: 0 },
        { from: "n2", to: "exit", iteration: 0 },
      ],
    });
    const exp = buildExplanation(detail, [], [], []);
    expect(exp.path).toEqual([
      { from: "start", to: "n1", iteration: 0 },
      { from: "n1", to: "n2", iteration: 0 },
      { from: "n2", to: "exit", iteration: 0 },
    ]);
  });

  test("per-step outcome folds node_completed.outcomeStatus", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "llm.start",
        payload: { nodeId: "n1" },
        runId: "r1",
        writer: "daemon" as const,
      },
      {
        seq: 2,
        ts: 2000,
        type: "fact.node_completed",
        payload: { nodeId: "n1", iteration: 0, outcomeStatus: "success" },
        runId: "r1",
        writer: "daemon" as const,
      },
      {
        seq: 3,
        ts: 3000,
        type: "fact.run_completed",
        payload: {},
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const steps: StepSnapshot[] = [
      {
        stepIdx: 0,
        startSeq: 1,
        nodeId: "n1",
        startedAt: new Date(1000).toISOString(),
        durationMs: 1000,
        cost: {
          input_tokens: 100,
          output_tokens: 50,
          cost_usd: 0.0025,
        },
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], steps);
    expect(exp.steps).toHaveLength(1);
    expect(exp.steps[0]!.outcome).toBe("success");
    expect(exp.steps[0]!.costUsd).toBeCloseTo(0.0025);
    expect(exp.steps[0]!.inputTokens).toBe(100);
    expect(exp.steps[0]!.outputTokens).toBe(50);
  });

  test("step outcome 'fail' when outcomeStatus=fail", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "fact.node_completed",
        payload: { nodeId: "n1", iteration: 0, outcomeStatus: "fail" },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const steps: StepSnapshot[] = [
      {
        stepIdx: 0,
        startSeq: 1,
        nodeId: "n1",
        startedAt: new Date(1000).toISOString(),
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], steps);
    expect(exp.steps[0]!.outcome).toBe("fail");
  });

  test("parentNodeId passes through so a renderer can nest fan-out branches", () => {
    // A parallel parent's branch sub-nodes carry parentNodeId (set by the steps
    // projection from fact.fanout_started); a non-branch step has none. The
    // explain projection must preserve the distinction so the CLI can mirror the
    // Cost tab's parent → branches nesting.
    const steps: StepSnapshot[] = [
      { stepIdx: 0, startSeq: 1, nodeId: "begin", startedAt: new Date(1000).toISOString() },
      { stepIdx: 1, startSeq: 2, nodeId: "a_scan", parentNodeId: "fan", startedAt: new Date(2000).toISOString() },
      { stepIdx: 2, startSeq: 3, nodeId: "b_scan", parentNodeId: "fan", startedAt: new Date(2000).toISOString() },
    ];
    const exp = buildExplanation(baseDetail(), [], [], steps);
    expect(exp.steps.map((s) => s.parentNodeId)).toEqual([undefined, "fan", "fan"]);
  });

  test("diff summary sums committed snapshot stats vs base", () => {
    const snaps: SnapshotItem[] = [
      {
        eventIdx: 1,
        nodeId: "n1",
        label: "step",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        committed: { filesChanged: 1, insertions: 5, deletions: 1 },
        uncommitted: null,
      },
      {
        eventIdx: 2,
        nodeId: "n2",
        label: "terminal",
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        committed: { filesChanged: 2, insertions: 8, deletions: 0 },
        uncommitted: null,
      },
    ];
    const exp = buildExplanation(baseDetail(), [], snaps, []);
    expect(exp.diffSummary).not.toBeNull();
    expect(exp.diffSummary!.filesChanged).toBe(3);
    expect(exp.diffSummary!.insertions).toBe(13);
    expect(exp.diffSummary!.deletions).toBe(1);
  });

  test("diff summary is null when no snapshots have committed stats", () => {
    const snaps: SnapshotItem[] = [
      {
        eventIdx: 1,
        nodeId: null,
        label: "hitl",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        committed: null,
        uncommitted: null,
      },
    ];
    const exp = buildExplanation(baseDetail(), [], snaps, []);
    expect(exp.diffSummary).toBeNull();
  });

  test("terminal halt reason surfaces in explanation.outcome", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "fact.run_halted",
        payload: { reason: "budget", detail: "run cost budget exhausted" },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.outcome.kind).toBe("halted");
    if (exp.outcome.kind === "halted") {
      expect(exp.outcome.reason).toBe("budget");
      expect(exp.outcome.detail).toBe("run cost budget exhausted");
    }
  });

  test("cancelled outcome captures reason", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "fact.run_cancelled",
        payload: { reason: "operator" },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.outcome.kind).toBe("cancelled");
    if (exp.outcome.kind === "cancelled") {
      expect(exp.outcome.reason).toBe("operator");
    }
  });

  test("paused_human outcome captures label", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "fact.run_paused_human",
        payload: { nodeId: "review", text: "Approve the changes?" },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.outcome.kind).toBe("paused_human");
    if (exp.outcome.kind === "paused_human") {
      expect(exp.outcome.label).toBe("Approve the changes?");
    }
  });

  test("budget.warn events without later budget.stop appear as warnings", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.82, ratio: 0.82 },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.budgetWarnings).toHaveLength(1);
    expect(exp.budgetWarnings[0]!.scope).toBe("run");
    expect(exp.budgetWarnings[0]!.metric).toBe("cost");
    expect(exp.budgetWarnings[0]!.ratio).toBeCloseTo(0.82);
  });

  test("budget.warn followed by budget.stop for same (scope,metric) is filtered out", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.82, ratio: 0.82 },
        runId: "r1",
        writer: "daemon" as const,
      },
      {
        seq: 2,
        ts: 2000,
        type: "budget.stop",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 1.05 },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.budgetWarnings).toHaveLength(0);
  });

  test("budget.warn for different (scope,metric) than stop is kept", () => {
    const events = [
      {
        seq: 1,
        ts: 1000,
        type: "budget.warn",
        payload: { scope: "run", metric: "tokens", limit: 100000, actual: 85000, ratio: 0.85 },
        runId: "r1",
        writer: "daemon" as const,
      },
      {
        seq: 2,
        ts: 2000,
        type: "budget.stop",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 1.05 },
        runId: "r1",
        writer: "daemon" as const,
      },
    ];
    const exp = buildExplanation(baseDetail(), events, [], []);
    expect(exp.budgetWarnings).toHaveLength(1);
    expect(exp.budgetWarnings[0]!.metric).toBe("tokens");
  });

  test("totals are summed from steps", () => {
    const steps: StepSnapshot[] = [
      {
        stepIdx: 0,
        startSeq: 1,
        nodeId: "n1",
        startedAt: new Date().toISOString(),
        cost: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_tokens: 1000,
          cache_write_tokens: 50,
          billed_tokens: 1350,
          cost_usd: 0.005,
        },
      },
      {
        stepIdx: 1,
        startSeq: 2,
        nodeId: "n2",
        startedAt: new Date().toISOString(),
        cost: {
          input_tokens: 300,
          output_tokens: 150,
          cache_read_tokens: 2000,
          cache_write_tokens: 100,
          billed_tokens: 2550,
          cost_usd: 0.007,
        },
      },
    ];
    const exp = buildExplanation(baseDetail(), [], [], steps);
    expect(exp.totals.costUsd).toBeCloseTo(0.012);
    expect(exp.totals.inputTokens).toBe(500);
    expect(exp.totals.outputTokens).toBe(250);
    expect(exp.totals.cacheReadTokens).toBe(3000);
    expect(exp.totals.cacheWriteTokens).toBe(150);
    expect(exp.totals.billedTokens).toBe(3900);
  });

  test("snapshot rows preserve canonical SnapshotStat fields", () => {
    const snaps: SnapshotItem[] = [
      {
        eventIdx: 5,
        nodeId: "n1",
        label: "step",
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        committed: { filesChanged: 3, insertions: 10, deletions: 2 },
        uncommitted: { filesChanged: 1, insertions: 2, deletions: 0 },
      },
    ];
    const exp = buildExplanation(baseDetail(), [], snaps, []);
    expect(exp.snapshots[0]!.committed!.filesChanged).toBe(3);
    expect(exp.snapshots[0]!.committed!.insertions).toBe(10);
    expect(exp.snapshots[0]!.uncommitted!.filesChanged).toBe(1);
    expect(exp.snapshots[0]!.uncommitted!.insertions).toBe(2);
  });
});
