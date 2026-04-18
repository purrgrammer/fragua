// Unit tests for BudgetLedger — the pure reducer. Executor-level
// integration (warn/stop events, non_retryable failure) lives in
// packages/core/test/executor/budget-enforcement.test.ts.

import { describe, expect, test } from "bun:test";
import { BudgetLedger, costDeltaFromEvent } from "../../src/engine/budget.ts";
import type { Event } from "../../src/types/events.ts";

function costEvent(node_id: string | undefined, cost: number, tokens = 0): Event {
  const base = {
    run_id: "r1",
    type: "cost.recorded" as const,
    timestamp: "2026-04-18T00:00:00.000Z",
    workflow_sha: "sha",
    schema_version: 1,
    data: { cost_usd: cost, total_tokens: tokens },
  };
  return node_id ? { ...base, node_id } : base;
}

describe("BudgetLedger — record / verdict shape", () => {
  test("no limits → always ok + cumulative ticks up", () => {
    const l = new BudgetLedger();
    const v = l.record({ node_id: "plan", cost_usd: 0.01, total_tokens: 100 }, {});
    expect(v.kind).toBe("ok");
    const s = l.snapshot();
    expect(s.cumulative_cost_usd).toBe(0.01);
    expect(s.cumulative_tokens).toBe(100);
    expect(s.per_node_cost_usd["plan"]).toBe(0.01);
  });

  test("node cost ceiling: warn at ≥80%, stop at ≥100%, each fires once", () => {
    const l = new BudgetLedger();
    const limits = { node_max_cost_usd: 1.0 };
    const v1 = l.record({ node_id: "n", cost_usd: 0.5, total_tokens: 0 }, limits);
    expect(v1.kind).toBe("ok");
    const v2 = l.record({ node_id: "n", cost_usd: 0.35, total_tokens: 0 }, limits);
    expect(v2.kind).toBe("warn");
    if (v2.kind === "warn") {
      expect(v2.scope).toBe("node");
      expect(v2.metric).toBe("cost");
      expect(v2.limit).toBe(1.0);
      expect(v2.actual).toBeCloseTo(0.85, 5);
      expect(v2.ratio).toBeCloseTo(0.85, 5);
    }
    // Another delta that stays in warn range must NOT re-fire warn.
    const v3 = l.record({ node_id: "n", cost_usd: 0.05, total_tokens: 0 }, limits);
    expect(v3.kind).toBe("ok");
    // Push past 100% → stop once.
    const v4 = l.record({ node_id: "n", cost_usd: 0.2, total_tokens: 0 }, limits);
    expect(v4.kind).toBe("stop");
    if (v4.kind === "stop") {
      expect(v4.actual).toBeCloseTo(1.1, 5);
    }
  });

  test("run-level ceiling tracks across nodes and across synthetic summariser nodes", () => {
    const l = new BudgetLedger();
    const limits = { run_max_cost_usd: 0.5 };
    // Real node spends half.
    expect(l.record({ node_id: "plan", cost_usd: 0.3, total_tokens: 0 }, limits).kind).toBe("ok");
    // Synthetic summariser node adds more under its own id — still counts run-wide.
    expect(l.record({ node_id: "__summary.plan", cost_usd: 0.15, total_tokens: 0 }, limits).kind).toBe("warn");
    // Tipping point.
    const breach = l.record({ node_id: "__summary.title", cost_usd: 0.1, total_tokens: 0 }, limits);
    expect(breach.kind).toBe("stop");
    if (breach.kind === "stop") {
      expect(breach.scope).toBe("run");
      expect(breach.actual).toBeCloseTo(0.55, 5);
    }
  });

  test("node scope wins over run scope when both trip at once", () => {
    const l = new BudgetLedger();
    const limits = { node_max_cost_usd: 0.1, run_max_cost_usd: 1.0 };
    const v = l.record({ node_id: "plan", cost_usd: 0.2, total_tokens: 0 }, limits);
    expect(v.kind).toBe("stop");
    if (v.kind === "stop") {
      expect(v.scope).toBe("node");
    }
  });

  test("tokens metric has its own latches — crossing cost doesn't silence token warn", () => {
    const l = new BudgetLedger();
    const limits = { node_max_cost_usd: 1.0, node_max_tokens: 1000 };
    // Cost warn fires.
    expect(l.record({ node_id: "n", cost_usd: 0.85, total_tokens: 0 }, limits).kind).toBe("warn");
    // Token warn still fires independently.
    const v = l.record({ node_id: "n", cost_usd: 0.0, total_tokens: 850 }, limits);
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") expect(v.metric).toBe("tokens");
  });

  test("preflight reports the already-breached scope without mutating state", () => {
    const l = new BudgetLedger();
    const limits = { node_max_cost_usd: 0.5 };
    l.record({ node_id: "n", cost_usd: 0.6, total_tokens: 0 }, limits);
    const q1 = l.query("n", limits);
    const pre = l.preflight("n", limits);
    expect(pre.kind).toBe("stop");
    const q2 = l.query("n", limits);
    // preflight must NOT add to cumulative.
    expect(q1.cumulative_cost_usd).toBe(q2.cumulative_cost_usd);
  });

  test("query shape matches the Wave-4 CodergenInput.budget contract", () => {
    const l = new BudgetLedger();
    l.record({ node_id: "n", cost_usd: 0.1, total_tokens: 42 }, {});
    const q = l.query("n", { node_max_cost_usd: 1.0, run_max_cost_usd: 2.0 });
    expect(q).toMatchObject({
      cumulative_cost_usd: 0.1,
      cumulative_tokens: 42,
      node_cost_usd: 0.1,
      node_tokens: 42,
      max_cost_usd: 1.0,
      run_max_cost_usd: 2.0,
    });
  });
});

describe("costDeltaFromEvent", () => {
  test("extracts cost + tokens from a valid cost.recorded event", () => {
    const d = costDeltaFromEvent(costEvent("n1", 0.01, 250));
    expect(d).toEqual({ node_id: "n1", cost_usd: 0.01, total_tokens: 250 });
  });

  test("falls back to input+output when total_tokens is absent", () => {
    const ev: Event = {
      run_id: "r1",
      node_id: "n1",
      type: "cost.recorded",
      timestamp: "2026-04-18T00:00:00.000Z",
      workflow_sha: "sha",
      data: { cost_usd: 0.0, input_tokens: 10, output_tokens: 5 },
    };
    expect(costDeltaFromEvent(ev)?.total_tokens).toBe(15);
  });

  test("returns undefined for non-cost events", () => {
    const ev: Event = {
      run_id: "r1",
      type: "llm.start",
      timestamp: "2026-04-18T00:00:00.000Z",
      workflow_sha: "sha",
      data: {},
    };
    expect(costDeltaFromEvent(ev)).toBeUndefined();
  });
});
