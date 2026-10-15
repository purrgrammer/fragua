// Property-based tests over the pure planExit (the exit arm, sibling of
// transition-planner.property.test.ts for the success arm). planExit is
// referentially transparent, so its invariants become properties over a
// generated ExitPlanInput — no store, no driven run.
//
// The decision order it must honour: leak > reactive-budget halt >
// reactive-budget pause > shutdown > watchdog timeout-retry/exhausted > throw >
// plain abort. node_aborted is always recorded first with the turn's spend; at
// most one terminal/pause fact rides with it; the driver's abort-loop ceiling
// (a second commit) is NOT in the plan.

import { describe, expect, test } from "bun:test";
import { AUTO_RESUME_AT_KEY } from "@fragua/core";
import fc from "fast-check";
import { pbtFaultRuns } from "../../../test/pbt-runs.ts";
import { type ExitKind, type ExitPlanInput, planExit } from "../src/abort-planner.ts";

const NODE_IDS = ["plan", "implement", "review", "gate"] as const;
const timeoutKey = (node: string): string => `internal.timeout_retries.${node}`;

const nat = fc.nat({ max: 1_000_000 });
const usd = fc.double({ min: 0, max: 100, noNaN: true });

const arbUsage = fc.record({
  turnBilled: nat,
  totalCostUsd: usd,
  totalInputTokens: nat,
  totalOutputTokens: nat,
  totalCacheReadTokens: nat,
  totalCacheWriteTokens: nat,
  totalInputCostUsd: usd,
  totalOutputCostUsd: usd,
  totalCacheReadCostUsd: usd,
  totalCacheWriteCostUsd: usd,
  lastModel: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
});

const arbPauseBreach = fc.record({
  scope: fc.constantFrom<"run" | "node">("run", "node"),
  metric: fc.constantFrom<"cost" | "tokens">("cost", "tokens"),
  limit: usd,
  actual: usd,
});

const EXIT_KINDS: readonly ExitKind[] = ["throw", "timeout", "abort", "shutdown", "leak"];

/** A full ExitPlanInput. `priorTimeoutAttempts` is woven into effectiveRouting
 * under the per-node counter key so the timeout-retry/exhaustion boundary is
 * exercised (max 5 reaches well past the cap). Budget flags + exit kind are
 * independently generated so every outcome is reached. */
const arbAbortInput: fc.Arbitrary<ExitPlanInput> = fc
  .record({
    node: fc.constantFrom(...NODE_IDS),
    iteration: fc.nat({ max: 10 }),
    exit: fc.constantFrom(...EXIT_KINDS),
    errorDetail: fc.string({ maxLength: 24 }),
    leakedAt: fc.nat({ max: 2_000_000_000_000 }),
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
    exit: r.exit,
    currentNode: r.node,
    iteration: r.iteration,
    errorDetail: r.errorDetail,
    leakedAt: r.leakedAt,
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
/** Presence of a `fact.run_terminated` carrying a given status (the collapsed
 *  terminal — fact-taxonomy.md §3.1). */
const hasStatus = (facts: { type: string; payload: unknown }[], status: string): boolean =>
  facts.some((f) => f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === status);

describe("planExit — properties", () => {
  test("A: pure — same input ⇒ equal plan, input never mutated", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const before = structuredClone(input);
        const a = planExit(input);
        const b = planExit(input);
        expect(a).toEqual(b);
        expect(input).toEqual(before);
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("planExit — every exit plan leads with spend-bearing node_aborted", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const { facts } = planExit(input);
        expect(facts.length).toBeGreaterThanOrEqual(1);
        expect(facts[0]?.type).toBe("fact.node_aborted");
        const p = facts[0]!.payload as { partialCostUsd: number; partialTokens: number };
        expect(p.partialCostUsd).toBe(input.usage.totalCostUsd);
        expect(p.partialTokens).toBe(input.usage.turnBilled);
        expect(facts.filter((f) => f.type === "fact.node_aborted").length).toBe(1);
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("planExit — at most one run-parking fact; none for abort_step/shutdown", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const { facts, outcome } = planExit(input);
        const parking = facts.filter((f) => f.type === "fact.run_terminated" || f.type === "fact.run_paused");
        expect(parking.length).toBeLessThanOrEqual(1);
        if (outcome === "abort_step" || outcome === "shutdown") expect(parking.length).toBe(0);
        const extra = facts.filter(
          (f) =>
            (f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "errored") ||
            f.type === "fact.run_paused" ||
            (f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "completed"),
        );
        expect(extra.length).toBeLessThanOrEqual(1);
        // Never a terminal-completed on the abort path.
        expect(hasStatus(facts, "completed")).toBe(false);
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("D: outcome ⇄ fact shape", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planExit(input);
        switch (plan.outcome) {
          case "halt":
            expect(hasStatus(plan.facts, "errored")).toBe(true);
            expect(has(plan.facts, "fact.run_paused")).toBe(false);
            break;
          case "pause":
            expect(has(plan.facts, "fact.run_paused")).toBe(true);
            expect(hasStatus(plan.facts, "errored")).toBe(false);
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
          case "shutdown":
            // node_aborted ONLY. The abort-loop ceiling pause is the driver's
            // second commit, never in the plan; shutdown never bumps it.
            expect(plan.facts.length).toBe(1);
            break;
        }
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("ABORT-OUTCOME-PARTITION: outcome is exactly one of halt|pause|timeout_retry|abort_step|shutdown", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const { outcome } = planExit(input);
        expect(["halt", "pause", "timeout_retry", "abort_step", "shutdown"]).toContain(outcome);
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("E: precedence — a leak beats everything, then budget halt beats pause beats the rest", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planExit(input);
        if (input.exit === "leak") {
          expect(plan.outcome).toBe("halt");
          expect(plan.facts.map((f) => f.type)).toEqual([
            "fact.node_aborted",
            "fact.handler_timeout_leaked",
            "fact.run_terminated",
          ]);
        } else if (input.reactiveBudgetHaltDetail !== undefined) {
          expect(plan.outcome).toBe("halt");
          const halted = plan.facts.find(
            (f) => f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "errored",
          );
          expect(reasonOf(halted!)).toBe("budget");
        } else if (input.reactiveBudgetPauseBreach !== undefined) {
          expect(plan.outcome).toBe("pause");
          const paused = plan.facts.find((f) => f.type === "fact.run_paused");
          expect(reasonOf(paused!)).toBe("budget");
        }
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("F: watchdog timeout — retry increments the counter + sets auto-resume; exhaustion halts", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        // Isolate the timeout arm: no budget breach, cause = timeout.
        const timeoutInput: ExitPlanInput = {
          ...input,
          exit: "timeout",
          reactiveBudgetHaltDetail: undefined,
          reactiveBudgetPauseBreach: undefined,
        };
        const plan = planExit(timeoutInput);
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
          const halted = plan.facts.find(
            (f) => f.type === "fact.run_terminated" && (f.payload as { status?: string }).status === "errored",
          );
          expect(reasonOf(halted!)).toBe("timeout_exhausted");
        }
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("H: an unbudgeted throw halts with reason=error carrying the error detail", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planExit({
          ...input,
          exit: "throw",
          reactiveBudgetHaltDetail: undefined,
          reactiveBudgetPauseBreach: undefined,
        });
        expect(plan.outcome).toBe("halt");
        const halted = plan.facts.find((f) => f.type === "fact.run_terminated");
        expect(reasonOf(halted!)).toBe("error");
        const detail = (halted!.payload as { detail?: string }).detail;
        if (input.errorDetail === undefined || input.errorDetail === "") expect(detail).toBeUndefined();
        else expect(detail).toBe(input.errorDetail);
        expect((plan.facts[0]!.payload as { cause: string }).cause).toBe("error");
      }),
      { numRuns: pbtFaultRuns(1000) },
    );
  });

  test("G: appendOpts — advanceAppliedTo = max(appliedSeqs)|undefined; routingPatch ⊇ routingDelta", () => {
    fc.assert(
      fc.property(arbAbortInput, (input) => {
        const plan = planExit(input);
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
      { numRuns: pbtFaultRuns(1000) },
    );
  });
});
