import { describe, expect, test } from "bun:test";
import type { StepSnapshot } from "../lib/api.ts";
import { mergeStepsByNode } from "./CostInspector.tsx";

function step(overrides: Partial<StepSnapshot>): StepSnapshot {
  return {
    stepIdx: 0,
    startSeq: 0,
    nodeId: "n",
    startedAt: new Date(1_700_000_000_000).toISOString(),
    ...overrides,
  };
}

function withCost(s: StepSnapshot, costUsd: number, tokens: number): StepSnapshot {
  return {
    ...s,
    cost: {
      cost_usd: costUsd,
      input_tokens: tokens,
      output_tokens: tokens,
      billed_tokens: tokens * 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  };
}

describe("mergeStepsByNode", () => {
  test("single-step group → returned verbatim, no turns field", () => {
    const a = withCost(step({ startSeq: 1, nodeId: "lens", originRunId: "r" }), 0.05, 100);
    const out = mergeStepsByNode([a]);
    expect(out).toHaveLength(1);
    expect(out[0]?.turns).toBeUndefined();
    expect(out[0]?.cost?.cost_usd).toBeCloseTo(0.05);
  });

  test("multi-turn codergen (3 llm.starts, same node, same run) → 1 row; cost summed; turns=3", () => {
    const base = { nodeId: "lens", originRunId: "r" } as const;
    const rows = [
      withCost(step({ ...base, startSeq: 4 }), 0.05, 100),
      withCost(step({ ...base, startSeq: 17 }), 0.05, 100),
      withCost(step({ ...base, startSeq: 21 }), 0.05, 100),
    ];
    const out = mergeStepsByNode(rows);
    expect(out).toHaveLength(1);
    expect(out[0]?.turns).toBe(3);
    expect(out[0]?.cost?.cost_usd).toBeCloseTo(0.15);
    expect(out[0]?.cost?.input_tokens).toBe(300);
    // Earliest startSeq wins as the identity.
    expect(out[0]?.startSeq).toBe(4);
  });

  test("different originRunId → separate rows (sub-run isolation)", () => {
    const a = withCost(step({ startSeq: 1, nodeId: "lens", originRunId: "child_a" }), 0.05, 100);
    const b = withCost(step({ startSeq: 1, nodeId: "lens", originRunId: "child_b" }), 0.05, 100);
    const out = mergeStepsByNode([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]?.originRunId).toBe("child_a");
    expect(out[1]?.originRunId).toBe("child_b");
  });

  test("sub-agent invocations of the same parent node keep their own rows (different parentStartSeq)", () => {
    const a = withCost(step({ startSeq: 10, nodeId: "n", subagentId: "s", parentStartSeq: 5 }), 0.01, 10);
    const b = withCost(step({ startSeq: 11, nodeId: "n", subagentId: "s", parentStartSeq: 50 }), 0.02, 20);
    const out = mergeStepsByNode([a, b]);
    expect(out).toHaveLength(2);
  });

  test("durationMs spans from earliest start to latest end across merged turns", () => {
    const t0 = 1_700_000_000_000;
    const a: StepSnapshot = {
      ...withCost(step({ startSeq: 1, nodeId: "n", originRunId: "r", startedAt: new Date(t0).toISOString() }), 0.01, 10),
      durationMs: 100,
    };
    const b: StepSnapshot = {
      ...withCost(
        step({ startSeq: 2, nodeId: "n", originRunId: "r", startedAt: new Date(t0 + 200).toISOString() }),
        0.01,
        10,
      ),
      durationMs: 50,
    };
    const out = mergeStepsByNode([a, b]);
    expect(out).toHaveLength(1);
    // First row starts at t0; b ends at t0+250. Merged dur = 250.
    expect(out[0]?.durationMs).toBe(250);
  });

  test("non-consecutive same-node steps stay separate (goal-gate retarget creates a new invocation)", () => {
    // Sub-agent rows fire between two invocations of the same parent
    // node — exactly the goal-gate retry shape. Each parent
    // invocation must stay its own row, otherwise the per-invocation
    // sub-agent grouping breaks.
    const auditA = withCost(step({ startSeq: 10, nodeId: "audit", originRunId: "r" }), 0.01, 10);
    const subA = withCost(
      step({ startSeq: 11, nodeId: "__subagent:a", subagentId: "a", parentNodeId: "audit", parentStartSeq: 10 }),
      0.02,
      20,
    );
    const auditB = withCost(step({ startSeq: 20, nodeId: "audit", originRunId: "r" }), 0.04, 40);
    const subB = withCost(
      step({ startSeq: 21, nodeId: "__subagent:b", subagentId: "b", parentNodeId: "audit", parentStartSeq: 20 }),
      0.05,
      50,
    );
    const out = mergeStepsByNode([auditA, subA, auditB, subB]);
    // 4 distinct rows: two `audit` invocations + two sub-agents.
    expect(out).toHaveLength(4);
    const auditRows = out.filter((s) => s.nodeId === "audit");
    expect(auditRows).toHaveLength(2);
    expect(auditRows.every((r) => r.turns === undefined)).toBe(true);
  });
});
