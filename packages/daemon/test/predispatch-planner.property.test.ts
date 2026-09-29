// Property: the pre-dispatch planner emits AT MOST ONE run-parking (terminal)
// fact for any input — the decision core never orders two conflicting halts /
// pauses in one turn (SPEC §3.11 / I12). Pure tier-1 property: no store, clock,
// or RNG, so it runs thousands of cases cheaply.

import { describe, expect, test } from "bun:test";
import type { FactEvent, RunState } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { planPreDispatch } from "../src/predispatch-planner.ts";

function mkState(contractVersion: number): RunState {
  return {
    runId: "r",
    version: 1,
    status: "running",
    currentNode: "n",
    workflowSha: "g",
    contractVersion,
    routing: {},
    metrics: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, nodeCosts: {} },
  } as unknown as RunState;
}

function isParkingFact(f: FactEvent): boolean {
  return f.type === "fact.run_paused" || f.type === "fact.run_terminated";
}

describe("planPreDispatch — property", () => {
  test("emits at most one terminal (run-parking) fact, and terminal ⇔ a fact was emitted", () => {
    fc.assert(
      fc.property(
        fc.record({
          contractVersion: fc.integer({ min: -3, max: 12 }),
          min: fc.integer({ min: 0, max: 3 }),
          max: fc.integer({ min: 3, max: 8 }),
          hasParseError: fc.boolean(),
          parseError: fc.string({ maxLength: 40 }),
          hasWorktreeError: fc.boolean(),
          worktreeError: fc.string({ maxLength: 40 }),
          dispatches: fc.nat({ max: 2000 }),
          effectiveMaxLoops: fc.nat({ max: 2000 }),
        }),
        (g) => {
          const plan = planPreDispatch({
            state: mkState(g.contractVersion),
            contractWindow: { min: g.min, max: g.max },
            ...(g.hasParseError ? { graphParseError: g.parseError } : {}),
            ...(g.hasWorktreeError ? { worktreeError: g.worktreeError } : {}),
            dispatches: g.dispatches,
            effectiveMaxLoops: g.effectiveMaxLoops,
          });
          const parking = plan.facts.filter(isParkingFact);
          expect(parking.length).toBeLessThanOrEqual(1);
          expect(plan.terminal).toBe(parking.length === 1);
          // A terminal plan carries exactly its one parking fact — nothing else.
          if (plan.terminal) expect(plan.facts).toHaveLength(1);
        },
      ),
      { numRuns: pbtRuns(500) },
    );
  });
});
