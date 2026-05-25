// The fragua CLI exit-code map (shared by `ci`, `run --follow`, `runs tail`).
// `cliExitCode` is the single status+reason → code function those commands exit
// through; these lock the contract a script branches on. The per-reason maps
// are `Record<Union, number>`, so totality is enforced by the type system (a
// missing literal is a compile error) — this suite pins the actual codes and
// the cross-cutting invariants.

import { describe, expect, test } from "bun:test";
import type { HaltReason, PauseReason, QuarantineReason, RunStatus } from "@fragua/types";
import { CLI_EXIT, cliExitCode, HALT_EXIT, PAUSE_EXIT, QUARANTINE_EXIT } from "../src/cli-exit.ts";

describe("cliExitCode — stop-state + reason → exit code", () => {
  test("a clean exit is the only zero", () => {
    expect(cliExitCode("completed")).toBe(0);
    expect(CLI_EXIT.ok).toBe(0);

    // Every other stop-state is non-zero — "must not exit 0 on failure".
    const nonZero: RunStatus[] = [
      "halted",
      "paused",
      "paused_human",
      "quarantined",
      "cancelled",
      "queued",
      "running",
      "paused_auto",
    ];
    for (const s of nonZero) expect(cliExitCode(s)).not.toBe(0);
  });

  test("cancellation uses the SIGINT convention", () => {
    expect(cliExitCode("cancelled")).toBe(130);
  });

  test("one code per HaltReason (band 10s), all distinct", () => {
    const reasons: HaltReason[] = [
      "error",
      "aborted_exit",
      "budget",
      "occ_exhausted",
      "timeout_exhausted",
      "route_not_picked",
      "route_call_not_isolated",
      "edge_no_match",
    ];
    for (const r of reasons) expect(cliExitCode("halted", { halt: r })).toBe(HALT_EXIT[r]);
    expect(new Set(reasons.map((r) => HALT_EXIT[r])).size).toBe(reasons.length);
    expect(reasons.every((r) => HALT_EXIT[r] >= 10 && HALT_EXIT[r] < 20)).toBe(true);
  });

  test("one code per operator PauseReason (band 30s), all distinct", () => {
    const operator: PauseReason[] = [
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
    ];
    for (const r of operator) expect(cliExitCode("paused", { pause: r })).toBe(PAUSE_EXIT[r]);
    expect(new Set(operator.map((r) => PAUSE_EXIT[r])).size).toBe(operator.length);
    expect(operator.every((r) => PAUSE_EXIT[r] >= 30 && PAUSE_EXIT[r] < 40)).toBe(true);
  });

  test("auto-wake PauseReasons are never a stop — they map to internal", () => {
    // The drive loop CONTINUES paused_auto; these can't legitimately be a stop.
    for (const r of ["provider_retry", "handler_retry", "timeout_retry"] as PauseReason[]) {
      expect(PAUSE_EXIT[r]).toBe(CLI_EXIT.internal);
    }
  });

  test("one code per QuarantineReason (band 50s), all distinct", () => {
    const reasons: QuarantineReason[] = ["orphan_side_effect", "other"];
    for (const r of reasons) expect(cliExitCode("quarantined", { quarantine: r })).toBe(QUARANTINE_EXIT[r]);
    expect(new Set(reasons.map((r) => QUARANTINE_EXIT[r])).size).toBe(reasons.length);
  });

  test("paused_human is a single code (no reason enum)", () => {
    expect(cliExitCode("paused_human")).toBe(CLI_EXIT.needsHuman);
  });

  test("a missing reason falls back to the band's generic code", () => {
    expect(cliExitCode("halted")).toBe(HALT_EXIT.error);
    expect(cliExitCode("paused")).toBe(PAUSE_EXIT.operator);
    expect(cliExitCode("quarantined")).toBe(QUARANTINE_EXIT.other);
  });

  test("a non-terminal status reached as a stop-state is the internal-error code", () => {
    expect(cliExitCode("paused_auto")).toBe(CLI_EXIT.internal);
    expect(cliExitCode("queued")).toBe(CLI_EXIT.internal);
    expect(cliExitCode("running")).toBe(CLI_EXIT.internal);
  });

  test("the bands don't collide across reason kinds", () => {
    const all = [
      ...Object.values(HALT_EXIT),
      ...Object.values(PAUSE_EXIT).filter((c) => c !== CLI_EXIT.internal),
      ...Object.values(QUARANTINE_EXIT),
      CLI_EXIT.ok,
      CLI_EXIT.usage,
      CLI_EXIT.needsHuman,
      CLI_EXIT.internal,
      CLI_EXIT.cancelled,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
