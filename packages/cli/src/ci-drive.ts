// The `fragua ci` drive loop — one run's worth of the daemon's
// `wakePending → claim → runOne` tick, extracted so the control flow is
// testable without the executor machinery (dispatcher / tools / llmCall).
//
// The headline behaviour lives here: the `paused_auto` arm — the daemon-owed
// clock tick (provider_retry / handler_retry / timeout_retry) — is CONTINUED.
// We honour its `auto_resume_at` backoff, then loop so `wake()` flips the run
// back to `queued` for re-claim, exactly as the daemon would. The loop only
// RETURNS (letting the command compute a non-zero exit) on a terminal state or
// an unanswerable pause — `paused` (operator action), `paused_human` (HITL),
// `quarantined` — because CI has no responder for those.

import type { RunStatus } from "@fragua/types";

export interface CiDriveDeps {
  /** Aborted on SIGINT/SIGTERM — the loop returns promptly. */
  shutdownSignal: AbortSignal;
  /** Tick prelude: drive any actionable pending intents / elapsed auto-resume
   * timers to `queued` (the daemon's `wakePending`). */
  wake(): void;
  /** Claim the run and dispatch it once if it is claimable (`queued`).
   * Resolves `true` iff it claimed + drove this run, `false` otherwise. */
  claimAndDispatch(): Promise<boolean>;
  /** The run's current status, or `undefined` if absent. */
  status(): RunStatus | undefined;
  /** `routing.internal.auto_resume_at` (ms epoch) for the parked run, or
   * `undefined` when unset. */
  autoResumeAt(): number | undefined;
  /** Sleep until `wakeAt` (ms epoch) or shutdown, whichever comes first. */
  sleepUntil(wakeAt: number | undefined): Promise<void>;
}

/** Drive one run to a stop-state, continuing every `paused_auto` cycle. */
export async function driveCiRun(deps: CiDriveDeps): Promise<void> {
  for (;;) {
    if (deps.shutdownSignal.aborted) return;
    deps.wake();
    if (await deps.claimAndDispatch()) continue;
    if (deps.status() === "paused_auto") {
      await deps.sleepUntil(deps.autoResumeAt());
      continue;
    }
    return; // terminal / paused / paused_human / quarantined → stop
  }
}
