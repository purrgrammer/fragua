import type { Database } from "bun:sqlite";
import { insertDaemonEvent } from "./daemon-queries.ts";
import { insertEventDaemon, selectAllOrphanSideEffects } from "./event-queries.ts";
import { crashRequeueActiveMsDelta, dispatchIntervalActiveMsDelta } from "./reducers.ts";
import {
  bumpRunSeq,
  selectRunningNonImportedRuns,
  selectRunStateRow,
  updateRunStateQuarantinedBySweep,
  updateRunStateReleasedClaim,
  updateRunStateRequeuedAfterCrash,
} from "./run-state-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import type { SweepResult } from "./types.ts";

/**
 * Heal crash damage on daemon startup.
 *
 *  (a) Requeue: any run stuck in 'running' is moved back to 'queued' with
 *      ready_at = now and a fact.run_requeued_after_crash event appended.
 *  (b) Quarantine orphans: runs with fact.side_effect_intent lacking a
 *      matching fact.side_effect_done / fact.side_effect_failed (keyed by
 *      idempotencyKey) are transitioned to 'quarantined' with a
 *      fact.run_quarantined event.
 *
 * paused, paused_human, and quarantined runs are not touched; they are
 * preserved exactly. (A paused_* run with an orphan
 * side-effect intent does flip to quarantined — quarantine takes
 * precedence over pause.)
 */
export interface StartupSweepOpts {
  /** Heartbeat timestamp captured from the dying daemon's lock just
   * before the eviction cleared it (the harness supervisor's
   * `evictDaemonLockIfStale`, or the daemon's startup TTL-reclaim). Threaded into
   * the `fact.run_requeued_after_crash` payload as `lastAliveAt` so
   * the reducer can credit pre-crash active time within ~5s. Omit on
   * the clean-acquire path. */
  priorHeartbeatAt?: number;
}

/** How many `BEGIN IMMEDIATE` attempts one run's heal gets. Each attempt
 * already waits out `busy_timeout` inside SQLite before reporting BUSY, so the
 * budget bounds the total wait at roughly `SWEEP_BUSY_ATTEMPTS × busy_timeout`. */
export const SWEEP_BUSY_ATTEMPTS = 3;

function isBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
  return err.message.includes("database is locked");
}

export function startupSweep(ctx: StoreCtx, opts?: StartupSweepOpts): SweepResult {
  const requeued: string[] = [];
  const quarantined = new Map<string, number[]>();

  // Read-only scans first — outside the write txn — to gather work + pre-serialize payloads.
  const orphans = selectAllOrphanSideEffects(ctx.db);
  for (const row of orphans) {
    const list = quarantined.get(row.run_id) ?? [];
    list.push(row.seq);
    quarantined.set(row.run_id, list);
  }

  const quarantinePayloads = new Map<string, string>();
  for (const [runId, seqs] of quarantined) {
    quarantinePayloads.set(runId, JSON.stringify({ reason: "orphan_side_effect", orphanedIntents: seqs }));
  }

  const running = selectRunningNonImportedRuns(ctx.db);
  const requeuePayloads = new Map<string, string>();
  for (const row of running) {
    const payload: { prevNode?: string; lastAliveAt?: number } = {};
    if (row.current_node != null) payload.prevNode = row.current_node;
    if (opts?.priorHeartbeatAt != null) payload.lastAliveAt = opts.priorHeartbeatAt;
    requeuePayloads.set(row.run_id, JSON.stringify(payload));
  }

  // Each run heals in its own BEGIN IMMEDIATE transaction: the write lock is
  // taken before the run's row is read, so a concurrent writer makes the heal
  // wait (busy_timeout) instead of failing a read→write upgrade. A run whose
  // heal still reports BUSY is retried; a non-BUSY throw (a corrupt or missing
  // row) or a spent budget rolls back that run alone and is recorded as
  // `daemon.sweep_run_failed`, so it can't abort the other runs' heal.
  const healRun = (runId: string, attempt: () => void): boolean => {
    let lastErr: unknown;
    let attempts = 0;
    while (attempts < SWEEP_BUSY_ATTEMPTS) {
      attempts++;
      try {
        attempt();
        return true;
      } catch (err) {
        lastErr = err;
        if (!isBusy(err)) break;
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const payload = JSON.stringify({ runId, error: message, attempts });
    try {
      insertDaemonEvent(ctx.db, "daemon.sweep_run_failed", payload, ctx.now(), runId);
    } catch {
      // The audit row needs the same lock that just defeated the heal; losing
      // it must not abort the remaining runs.
    }
    return false;
  };

  // Quarantine orphan runs (only those currently in a non-terminal,
  // non-quarantined state). Quarantine runs BEFORE requeue so it takes
  // precedence: a run flagged here is re-read as non-'running' below.
  for (const runId of quarantined.keys()) {
    healRun(runId, () =>
      ctx.writeTxn(() => {
        const ts = ctx.now();
        const stateRow = selectRunStateRow(ctx.db, runId);
        if (stateRow == null) return;
        if (
          stateRow.status === "completed" ||
          stateRow.status === "cancelled" ||
          stateRow.status === "halted" ||
          stateRow.status === "quarantined" ||
          // An imported run's orphans were the source's concern — never quarantine
          // (it would mutate an inert, inspect-only run).
          stateRow.imported === 1
        ) {
          return;
        }

        const seq = bumpRunSeq(ctx.db, runId);
        insertEventDaemon(ctx.db, runId, seq, "fact.run_quarantined", quarantinePayloads.get(runId)!, ts);
        // Leave last_applied_seq alone: sweep doesn't fold operator
        // intents, so it can't pretend they've been applied. Advancing
        // the watermark past, e.g., a pre-crash intent.cancel_requested
        // would silently drop it from the next executor fold.
        updateRunStateQuarantinedBySweep(ctx.db, {
          runId,
          now: ts,
          activeMsDelta: dispatchIntervalActiveMsDelta(stateRow.dispatch_started_at, ts),
        });
      }),
    );
  }

  // Requeue runs still in 'running'. Re-read status here (per run)
  // because the quarantine loop above may have moved some of them.
  for (const row of running) {
    let didRequeue = false;
    const healed = healRun(row.run_id, () =>
      ctx.writeTxn(() => {
        didRequeue = false;
        const current = selectRunStateRow(ctx.db, row.run_id);
        if (current == null || current.status !== "running") return;
        // Sweep bypasses the reducer, so the activeMs credit in applyFact for
        // fact.run_requeued_after_crash doesn't fire here. Compute it via the
        // same shared helper the reducer calls, then apply it in SQL — one
        // source of truth so the fold and the projection can't drift.
        const activeMsDelta = crashRequeueActiveMsDelta(current.dispatch_started_at, opts?.priorHeartbeatAt);
        appendCrashRequeue(ctx.db, {
          runId: row.run_id,
          payloadJson: requeuePayloads.get(row.run_id) ?? "{}",
          ts: ctx.now(),
          activeMsDelta,
        });
        didRequeue = true;
      }),
    );
    if (healed && didRequeue) requeued.push(row.run_id);
  }

  return {
    requeued,
    quarantined: Array.from(quarantined.keys()),
  };
}

/**
 * Requeue a `running` run in SQL: append `fact.run_requeued_after_crash` and
 * flip the projection to `queued`, bumping `claim_epoch` so the fiber that held
 * the run can no longer commit. `current_node` is preserved so the executor
 * resumes on the in-flight node instead of re-running from the start node
 * (partial-side-effect safety is the orphan quarantine pass's job).
 *
 * With `claimEpoch` set (the executor releasing its own claim) the flip is
 * guarded on the run still being `running` under that epoch and nothing is
 * written when it isn't; the startup sweep omits it. Pure SQL — callers
 * pre-serialize `payloadJson` and compute `activeMsDelta` (via
 * `crashRequeueActiveMsDelta`) so this is safe inside a write transaction.
 */
export function appendCrashRequeue(
  db: Database,
  args: { runId: string; payloadJson: string; ts: number; activeMsDelta: number; claimEpoch?: number },
): boolean {
  const { runId, ts, activeMsDelta } = args;
  if (args.claimEpoch !== undefined) {
    if (!updateRunStateReleasedClaim(db, { runId, claimEpoch: args.claimEpoch, readyAt: ts, now: ts, activeMsDelta })) {
      return false;
    }
  } else {
    updateRunStateRequeuedAfterCrash(db, { runId, readyAt: ts, now: ts, activeMsDelta });
  }
  const seq = bumpRunSeq(db, runId);
  insertEventDaemon(db, runId, seq, "fact.run_requeued_after_crash", args.payloadJson, ts);
  return true;
}
