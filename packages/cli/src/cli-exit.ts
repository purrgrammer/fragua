// Exit-code taxonomy for the fragua CLI — shared by `ci`, `run --follow`, and
// `runs tail`. One code per terminal reason: a script can `case $?` on exactly
// why a run stopped. Codes are banded by status-class for legibility (10s halt,
// 30s operator-pause, 50s quarantine), leaving 0 for a clean exit and 130 for
// cancellation (the SIGINT convention).
//
// The per-reason maps are `Record<Union, number>`, so the totality check is
// the type system itself: adding a `HaltReason` / `PauseReason` /
// `QuarantineReason` literal without a code is a compile error (CLAUDE.md
// ground rule 1, enum-literal consumers). NOTE: because each engine reason is
// now a public exit code, adding a reason is a CLI contract change — pick the
// next code in the band and document it here.
//
// `ci`'s drive loop CONTINUES the `paused_auto` arm (provider_retry /
// handler_retry / timeout_retry), so it never STOPS on one — they map to
// `internal` only to keep `PAUSE_EXIT` total; reaching a stop with one is a
// driver bug. (`run`/`runs` only tail, so they never observe a `paused_auto`
// as terminal either — the daemon resolves it.)

import type { HaltReason, PauseReason, QuarantineReason, RunStatus } from "@fragua/types";

/** Status-class singletons + the well-known codes. Per-reason codes live in
 * the maps below. */
export const CLI_EXIT = {
  /** `completed` — reached the `<exit>` sink cleanly. The only zero. */
  ok: 0,
  /** `ci` could not run the workflow at all: not found / unparseable / bad
   * config / an unexpected throw. Not a run outcome — a generic invocation
   * failure (the conventional `1`). */
  usage: 1,
  /** `paused_human` — the workflow asked a question (HITL). No responder
   * in CI. (Single code: `paused_human` carries no reason enum.) */
  needsHuman: 60,
  /** A non-terminal status (`queued` / `running` / `paused_auto`) observed
   * as a STOP-state — a `ci` driver bug, not a workflow outcome. */
  internal: 70,
  /** `runs wait --timeout` expired before every selected run settled. A
   * deadline outcome, not a run outcome — distinct so a fleet script can
   * branch on "gave up waiting" specifically. */
  timeout: 75,
  /** A live secret value (provider-credential or `env:*` literal) was found
   * VERBATIM in an UN-SCRUBBED binary artifact shipped in the bundle (text
   * surfaces are always scrubbed; binary artifacts ship as-is and are scanned
   * at export — see docs/proposals/secret-scrubbing.md §13). The run may have
   * completed, but the job FAILS CLOSED: a leaky bundle must never be
   * published. Distinct from `usage` so CI can branch on "secret leak"
   * specifically. */
  scrubLeak: 80,
  /** `cancelled`, or a SIGINT/SIGTERM-interrupted drive. 128 + SIGINT(2). */
  cancelled: 130,
} as const;

/** `halted` reason → exit code (band 10–19). */
export const HALT_EXIT: Record<HaltReason, number> = {
  error: 10,
  aborted_exit: 11,
  budget: 12,
  occ_exhausted: 13,
  timeout_exhausted: 14,
  route_not_picked: 15,
  route_call_not_isolated: 16,
  edge_no_match: 17,
};

/** `paused` reason → exit code (band 30–39). The auto-wake reasons project
 * to `paused_auto` (which the loop continues), so they can't be a stop —
 * they map to `internal` only to keep the record total. */
export const PAUSE_EXIT: Record<PauseReason, number> = {
  operator: 30,
  provider_error: 31,
  payment_required: 32,
  budget: 33,
  max_retries: 34,
  goal_gate: 35,
  max_loops: 36,
  abort_loop: 37,
  provider_exhausted: 38,
  engine_incompatible: 39,
  provider_retry: CLI_EXIT.internal,
  handler_retry: CLI_EXIT.internal,
  timeout_retry: CLI_EXIT.internal,
};

/** `quarantined` reason → exit code (band 50–59). */
export const QUARANTINE_EXIT: Record<QuarantineReason, number> = {
  orphan_side_effect: 50,
  other: 51,
};

/** The reason carried by a stop-state's terminal fact, by kind. Only the one
 * matching the final status is consulted; the others are ignored. */
export interface StopReason {
  halt?: HaltReason;
  pause?: PauseReason;
  quarantine?: QuarantineReason;
}

/** Stop-state → exit code. Exhaustive over {@link RunStatus}; the per-reason
 * codes come from the maps above. A missing reason falls back to the band's
 * generic code (the reason should always be present on the terminal fact;
 * this is defensive). */
export function cliExitCode(status: RunStatus, reason: StopReason = {}): number {
  switch (status) {
    case "completed":
      return CLI_EXIT.ok;
    case "cancelled":
      return CLI_EXIT.cancelled;
    case "halted":
      return HALT_EXIT[reason.halt ?? "error"];
    case "paused":
      return PAUSE_EXIT[reason.pause ?? "operator"];
    case "paused_human":
      return CLI_EXIT.needsHuman;
    case "quarantined":
      return QUARANTINE_EXIT[reason.quarantine ?? "other"];
    case "queued":
    case "running":
    case "paused_auto":
      return CLI_EXIT.internal;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
