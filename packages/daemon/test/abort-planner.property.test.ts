// Property-based tests over the pure planAbort (executor PBT Phase 4 — the
// abort arm, sibling of transition-planner.property.test.ts for the success
// arm). planAbort is referentially transparent, so its invariants become
// properties over a generated AbortPlanInput — no store, no driven run.
//
// The decision order it must honour: reactive-budget halt > reactive-budget
// pause > watchdog timeout-retry/exhausted > plain abort. node_aborted is
// always recorded (partial spend); at most one terminal/pause fact rides with
// it; the executor's abort-loop ceiling (a second commit) is NOT in the plan.

import { describe, expect, test } from "bun:test";
import { AUTO_RESUME_AT_KEY } from "@fragua/core";
import fc from "fast-check";
import { type AbortPlanInput, planAbort } from "../src/abort-planner.ts";
import { pbtRuns } from "./pbt-runs.ts";

const NODE_IDS = ["plan", "implement", "review", "gate"] as const;
const timeoutKey = (node: string): string => `internal.timeout_retries.${node}`;

const nat = fc.nat({ max: 1_000_000 });
const usd = fc.double({ min: 0, max: 100, noNaN: true });

const arbUsage = fc.record({
  tokens: nat,
  costUsd: usd,
  inputTokens: nat,
  outputTokens: nat,
  cacheReadTokens: nat,
  cacheWriteTokens: nat,
});

const arbPauseBreach = fc.record({
  scope: fc.constantFrom<"run" | "node">("run", "node"),
  metric: fc.constantFrom<"cost" | "tokens">("cost", "tokens"),
  limit: usd,
  actual: usd,
});

/** A full AbortPlanInput. `priorTimeoutAttempts` is woven into effectiveRouting
 * under the per-node counter key so the timeout-retry/exhaustion boundary is
 * exercised (max 5 reaches well past the cap). Budget flags + abortCause are
 * independently optional so all four outcomes are generated. */
const arbAbortInput: fc.Arbitrary<AbortPlanInput> = fc
  .record({
    node: fc.constantFrom(...NODE_IDS),
    iteration: fc.nat({ max: 10 }),
    abortCause: fc.constantFrom("timeout", "aborted"),
    reactiveBudgetHaltDetail: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
    reactiveBudgetPauseBreach: fc.option(arbPauseBreach, { nil: undefined }),
    usage: arbUsage,
    routingDelta: fc.dictionary(fc.constantFrom("k1", "k2", "internal.x"), fc.oneof(nat, fc.string()), { maxKeys: 3 }),
    appliedSeqs: fc.uniqueArray(fc.nat({ max: 100_000 }), { maxLength: 5 }),
    priorTimeoutAttempts: fc.nat({ max: 5 }),
    extraRouting: fc.dictionary(fc.constantFrom("a", "b"), fc.string(), { maxKeys: 2 }),
    now: fc.nat({ max: 2_000_000_000_000 }),
    attemptedMs: fc.nat({ max: 600_000 }),
  })
  .map((r) => ({
    currentNode: r.node,
    iteration: r.iteration,
    abortCause: r.abortCause,
    reactiveBudgetHaltDetail: r.reactiveBudgetHaltDetail,
    reactiveBudgetPauseBreach: r.reactiveBudgetPauseBreach,
    usage: r.usage,
    routingDelta: r.routingDelta,
    appliedSeqs: r.appliedSeqs,
    effectiveRouting: { ...r.extraRouting, [timeoutKey(r.node)]: r.priorTimeoutAttempts },
    now: r.now,
    attemptedMs: r.attemptedMs,
  }));

const reasonOf = (f: { payload: unknown }): string | undefined => (f.payload as { reason?: string }).reason;
const has = (facts: { type: string }[], type: string): boolean => facts.some((f) => f.type === type);

describe("planAbort — properties", () => {
  test("A: pure — same input ⇒ equal plan, input never mutated", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const before = structuredClone(input);
        const a = planAbort(input);
        const b = planAbort(input);
        expect(a).toEqual(b);
        expect(input).toEqual(before);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("B: fact.node_aborted is always recorded first", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const { facts } = planAbort(input);
        expect(facts.length).toBeGreaterThanOrEqual(1);
        expect(facts[0]?.type).toBe("fact.node_aborted");
        // ...and only once.
        expect(facts.filter((f) => f.type === "fact.node_aborted").length).toBe(1);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("C: at most one terminal/pause fact rides with the abort", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const { facts } = planAbort(input);
        const extra = facts.filter(
          (f) => f.type === "fact.run_halted" || f.type === "fact.run_paused" || f.type === "fact.run_completed",
        );
        expect(extra.length).toBeLessThanOrEqual(1);
        // Never a terminal-completed on the abort path.
        expect(has(facts, "fact.run_completed")).toBe(false);
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("D: outcome ⇄ fact shape", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planAbort(input);
        switch (plan.outcome) {
          case "halt":
            expect(has(plan.facts, "fact.run_halted")).toBe(true);
            expect(has(plan.facts, "fact.run_paused")).toBe(false);
            break;
          case "pause":
            expect(has(plan.facts, "fact.run_paused")).toBe(true);
            expect(has(plan.facts, "fact.run_halted")).toBe(false);
            break;
          case "timeout_retry": {
            const paused = plan.facts.find((f) => f.type === "fact.run_paused");
            expect(paused).toBeDefined();
            expect(reasonOf(paused!)).toBe("timeout_retry");
            // routingPatch carries the auto-wake timestamp so the daemon re-dispatches.
            expect(plan.routingPatch?.[AUTO_RESUME_AT_KEY]).toBeTypeOf("number");
            break;
          }
          case "abort_step":
            // Plain abort: node_aborted ONLY. The abort-loop ceiling pause is
            // the executor's second commit, never in the plan.
            expect(plan.facts.length).toBe(1);
            break;
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("E: reactive-budget precedence — halt beats pause beats everything else", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planAbort(input);
        if (input.reactiveBudgetHaltDetail !== undefined) {
          expect(plan.outcome).toBe("halt");
          const halted = plan.facts.find((f) => f.type === "fact.run_halted");
          expect(reasonOf(halted!)).toBe("budget");
        } else if (input.reactiveBudgetPauseBreach !== undefined) {
          expect(plan.outcome).toBe("pause");
          const paused = plan.facts.find((f) => f.type === "fact.run_paused");
          expect(reasonOf(paused!)).toBe("budget");
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("F: watchdog timeout — retry increments the counter + sets auto-resume; exhaustion halts", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        // Isolate the timeout arm: no budget breach, cause = timeout.
        const timeoutInput: AbortPlanInput = {
          ...input,
          abortCause: "timeout",
          reactiveBudgetHaltDetail: undefined,
          reactiveBudgetPauseBreach: undefined,
        };
        const plan = planAbort(timeoutInput);
        const prior = (timeoutInput.effectiveRouting[timeoutKey(timeoutInput.currentNode)] as number) ?? 0;
        if (plan.outcome === "timeout_retry") {
          // Counter advanced by exactly one, auto-resume is in the future.
          expect(plan.routingPatch?.[timeoutKey(timeoutInput.currentNode)]).toBe(prior + 1);
          expect(plan.routingPatch?.[AUTO_RESUME_AT_KEY] as number).toBeGreaterThan(timeoutInput.now);
          // The fold's routing delta is preserved alongside.
          for (const k of Object.keys(timeoutInput.routingDelta)) {
            expect(plan.routingPatch?.[k]).toEqual(timeoutInput.routingDelta[k]);
          }
        } else {
          // Exhausted → terminal halt with the operator-readable reason.
          expect(plan.outcome).toBe("halt");
          const halted = plan.facts.find((f) => f.type === "fact.run_halted");
          expect(reasonOf(halted!)).toBe("timeout_exhausted");
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });

  test("G: appendOpts — advanceAppliedTo = max(appliedSeqs)|undefined; routingPatch ⊇ routingDelta", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planAbort(input);
        if (input.appliedSeqs.length === 0) {
          expect(plan.advanceAppliedTo).toBeUndefined();
        } else {
          expect(plan.advanceAppliedTo).toBe(Math.max(...input.appliedSeqs));
        }
        // Whenever a routing patch is emitted, it preserves every fold key.
        if (plan.routingPatch !== undefined) {
          for (const k of Object.keys(input.routingDelta)) {
            expect(plan.routingPatch[k]).toEqual(input.routingDelta[k]);
          }
        } else {
          // No patch ⇒ the fold delta was empty.
          expect(Object.keys(input.routingDelta).length).toBe(0);
        }
      }),
      { numRuns: pbtRuns(1000) },
    );
  });
});
