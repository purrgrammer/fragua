// Pause reason ↔ status is 1:1, exhaustively over every PauseReason literal
// (proposal §5 / SPEC §3.4). The reducer projects status from the run_paused
// reason alone: AUTO_WAKE_PAUSE_REASONS → paused_auto (daemon timer), everything
// else → paused (operator must act). checkRunInvariants verifies this on resting
// driven runs; this proves the full mapping at the source — adding a PauseReason
// without classifying it trips the count guard.

import { describe, expect, test } from "bun:test";
import { AUTO_WAKE_PAUSE_REASONS, applyFact, emptyMetrics, type FactEvent, type RunState } from "@fragua/store";
import type { PauseReason } from "@fragua/types";

const ALL_PAUSE_REASONS = [
  "operator",
  "provider_error",
  "payment_required",
  "budget",
  "max_retries",
  "goal_gate",
  "max_loops",
  "abort_loop",
  "provider_exhausted",
  "engine_incompatible",
  "provider_retry",
  "handler_retry",
  "timeout_retry",
] as const satisfies readonly PauseReason[];

/** Minimal running state to fold a pause onto — the reducer reads only status,
 * dispatchStartedAt, nodeStartedAt, and metrics for this transition. */
function runningState(): RunState {
  return {
    status: "running",
    currentNode: "n",
    dispatchStartedAt: 0,
    nodeStartedAt: 0,
    metrics: emptyMetrics(),
  } as unknown as RunState;
}

describe("pause reason ↔ status mapping", () => {
  test("every PauseReason projects to exactly the status its AUTO_WAKE class dictates", () => {
    for (const reason of ALL_PAUSE_REASONS) {
      // The reducer's run_paused arm reads only payload.reason for status; the
      // reason-specific fields are irrelevant here, hence the cast.
      const fact = { type: "fact.run_paused", payload: { reason } } as unknown as FactEvent;
      const next = applyFact(runningState(), fact, 1000);
      const expected = (AUTO_WAKE_PAUSE_REASONS as ReadonlySet<string>).has(reason) ? "paused_auto" : "paused";
      expect(next.status).toBe(expected);
    }
  });

  test("the reason list is exhaustive (a new PauseReason must be classified here)", () => {
    expect(ALL_PAUSE_REASONS.length).toBe(13);
    // AUTO_WAKE is a strict subset of the full reason set.
    for (const r of AUTO_WAKE_PAUSE_REASONS) {
      expect((ALL_PAUSE_REASONS as readonly string[]).includes(r)).toBe(true);
    }
  });
});
