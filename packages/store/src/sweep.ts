import type { Database } from "bun:sqlite";
import { insertDaemonEvent } from "./daemon-queries.ts";
import { insertEventDaemon, selectAllOrphanSideEffects } from "./event-queries.ts";
import { crashRequeueActiveMsDelta } from "./reducers.ts";
import {
  bumpRunSeq,
  selectRunningNonImportedRuns,
  selectRunStateRow,
  updateRunStateQuarantinedBySweep,
  updateRunStateRequeuedAfterCrash,
} from "./run-state-queries.ts";
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

export function startupSweep(db: Database, now: () => number, opts?: StartupSweepOpts): SweepResult {
  const requeued: string[] = [];
  const quarantined = new Map<string, number[]>();

  // Read-only scans first — outside the write txn — to gather work + pre-serialize payloads.
  const orphans = selectAllOrphanSideEffects(db);
  for (const row of orphans) {
    const list = quarantined.get(row.run_id) ?? [];
    list.push(row.seq);
    quarantined.set(row.run_id, list);
  }

  // Pre-serialize quarantine payloads so the write txn is pure DB work.
  const quarantinePayloads = new Map<string, string>();
  for (const [runId, seqs] of quarantined) {
    quarantinePayloads.set(runId, JSON.stringify({ reason: "orphan_side_effect", orphanedIntents: seqs }));
  }

  const running = selectRunningNonImportedRuns(db);
  const requeuePayloads = new Map<string, string>();
  for (const row of running) {
    const payload: { prevNode?: string; lastAliveAt?: number } = {};
    if (row.current_node != null) payload.prevNode = row.current_node;
    if (opts?.priorHeartbeatAt != null) payload.lastAliveAt = opts.priorHeartbeatAt;
    requeuePayloads.set(row.run_id, JSON.stringify(payload));
  }

  // Each run's mutation runs in its own SAVEPOINT. A single corrupt or
  // missing `run_state` row that throws mid-mutation is rolled back to
  // its savepoint and recorded as a `daemon.sweep_run_failed`
  // observability event — it can't abort the sweep of any other run or
  // crash-loop the daemon at boot. (Contrast the old single outer
  // BEGIN IMMEDIATE, where one throw discarded every other run's heal.)
  const sweepRun = (runId: string, mutate: () => void): void => {
    db.exec("SAVEPOINT sweep_run");
    try {
      mutate();
      db.exec("RELEASE sweep_run");
    } catch (err) {
      try {
        db.exec("ROLLBACK TO sweep_run");
        db.exec("RELEASE sweep_run");
      } catch {
        // best-effort savepoint cleanup
      }
      const message = err instanceof Error ? err.message : String(err);
      insertDaemonEvent(db, "daemon.sweep_run_failed", JSON.stringify({ runId, error: message }), now(), runId);
    }
  };

  // Quarantine orphan runs (only those currently in a non-terminal,
  // non-quarantined state). Quarantine runs BEFORE requeue so it takes
  // precedence: a run flagged here is re-read as non-'running' below.
  for (const [runId, _seqs] of quarantined) {
    sweepRun(runId, () => {
      const ts = now();
      const stateRow = selectRunStateRow(db, runId);
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

      const seq = bumpRunSeq(db, runId);
      insertEventDaemon(db, runId, seq, "fact.run_quarantined", quarantinePayloads.get(runId)!, ts);
      // Leave last_applied_seq alone: sweep doesn't fold operator
      // intents, so it can't pretend they've been applied. Advancing
      // the watermark past, e.g., a pre-crash intent.cancel_requested
      // would silently drop it from the next executor fold.
      updateRunStateQuarantinedBySweep(db, runId, ts);
    });
  }

  // Requeue runs still in 'running'. Re-read status here (per run)
  // because the quarantine loop above may have moved some of them.
  for (const row of running) {
    sweepRun(row.run_id, () => {
      const current = selectRunStateRow(db, row.run_id);
      if (current == null || current.status !== "running") return;
      const ts = now();
      const seq = bumpRunSeq(db, row.run_id);
      insertEventDaemon(
        db,
        row.run_id,
        seq,
        "fact.run_requeued_after_crash",
        requeuePayloads.get(row.run_id) ?? "{}",
        ts,
      );
      // Sweep bypasses the reducer, so the activeMs credit in applyFact for
      // fact.run_requeued_after_crash doesn't fire here. Compute it via the
      // same shared helper the reducer calls, then apply it in SQL — one
      // source of truth so the fold and the projection can't drift.
      const activeMsDelta = crashRequeueActiveMsDelta(current.dispatch_started_at, opts?.priorHeartbeatAt);
      // Preserve current_node so the executor resumes on the in-flight node
      // instead of re-emitting fact.run_started and re-running the workflow
      // from the start node. Partial-side-effect safety is covered by the
      // orphan quarantine pass above; rerun-from-start was never the
      // intended recovery semantics.
      updateRunStateRequeuedAfterCrash(db, { runId: row.run_id, readyAt: ts, now: ts, activeMsDelta });
      requeued.push(row.run_id);
    });
  }

  return {
    requeued,
    quarantined: Array.from(quarantined.keys()),
  };
}
