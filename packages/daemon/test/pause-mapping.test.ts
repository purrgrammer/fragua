// Pause reason ↔ status is 1:1, exhaustively over every PauseReason literal
// (proposal §5 / SPEC §3.4). The reducer projects status from the run_paused
// reason alone: AUTO_WAKE_PAUSE_REASONS → paused_auto (daemon timer), everything
// else → paused (operator must act). checkRunInvariants verifies this on resting
// driven runs; this proves the full mapping at the source. EXPECTED_STATUS is an
// explicit `Record<PauseReason, …>` — the reducer is a catch-all (unknown reason
// → paused), so the gate lives in this hand-written mapping: its key set must
// equal PAUSE_REASONS exactly (both directions). Adding a PauseReason without a
// row here fails typecheck (Record<PauseReason>) AND this runtime set-equality.

import { describe, expect, test } from "bun:test";
import { AUTO_WAKE_PAUSE_REASONS, applyFact, emptyMetrics, type FactEvent, type RunState } from "@fragua/store";
import { PAUSE_REASONS, type PauseReason } from "@fragua/types";

/** The classification every PauseReason must resolve to. Keyed by the union so
 * TypeScript forces a row per reason; the runtime set-equality below pins the
 * key set to PAUSE_REASONS so a literal can't be added on only one side. */
const EXPECTED_STATUS: Record<PauseReason, "paused" | "paused_auto"> = {
  operator: "paused",
  provider_error: "paused",
  payment_required: "paused",
  budget: "paused",
  max_retries: "paused",
  goal_gate: "paused",
  max_loops: "paused",
  abort_loop: "paused",
  provider_exhausted: "paused",
  engine_incompatible: "paused",
  provider_retry: "paused_auto",
  handler_retry: "paused_auto",
  timeout_retry: "paused_auto",
};

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
  test("every PauseReason projects to exactly the status EXPECTED_STATUS dictates", () => {
    for (const reason of PAUSE_REASONS) {
      // The reducer's run_paused arm reads only payload.reason for status; the
      // reason-specific fields are irrelevant here, hence the cast.
      const fact = { type: "fact.run_paused", payload: { reason } } as unknown as FactEvent;
      const next = applyFact(runningState(), fact, 1000);
      expect(next.status).toBe(EXPECTED_STATUS[reason]);
    }
  });

  test("EXPECTED_STATUS agrees with AUTO_WAKE_PAUSE_REASONS (paused_auto iff auto-wake)", () => {
    for (const reason of PAUSE_REASONS) {
      const isAutoWake = (AUTO_WAKE_PAUSE_REASONS as ReadonlySet<string>).has(reason);
      expect(EXPECTED_STATUS[reason]).toBe(isAutoWake ? "paused_auto" : "paused");
    }
  });

  test("the mapping key set equals PAUSE_REASONS exactly — a new PauseReason must be classified here", () => {
    // Set-equality both directions: every tuple member has a mapping row, and
    // every mapping row is a tuple member. Adding a literal to PAUSE_REASONS
    // without a row (or vice versa) breaks this.
    expect(new Set<string>(Object.keys(EXPECTED_STATUS))).toEqual(new Set<string>(PAUSE_REASONS));
  });
});
