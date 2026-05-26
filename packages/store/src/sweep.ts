import type { Database } from "bun:sqlite";
import type { SweepResult } from "./types.ts";

interface RunningRow {
  run_id: string;
  version: number;
  current_node: string | null;
}

interface OrphanRow {
  run_id: string;
  seq: number;
  idempotency_key: string;
}

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
   * before the reaper called `forceAcquireDaemonLock`. Threaded into
   * the `fact.run_requeued_after_crash` payload as `lastAliveAt` so
   * the reducer can credit pre-crash active time within ~5s. Omit on
   * the clean-acquire path. */
  priorHeartbeatAt?: number;
}

export function startupSweep(db: Database, now: () => number, opts?: StartupSweepOpts): SweepResult {
  const requeued: string[] = [];
  const quarantined = new Map<string, number[]>();

  // Read-only scans first — outside the write txn — to gather work + pre-serialize payloads.
  const orphans = db
    .query<OrphanRow, []>(
      `SELECT i.run_id,
              i.seq,
              json_extract(i.payload, '$.idempotencyKey') AS idempotency_key
         FROM events i
         LEFT JOIN events d
                ON d.run_id = i.run_id
               AND d.type IN ('fact.side_effect_done','fact.side_effect_failed')
               AND json_extract(d.payload, '$.idempotencyKey') =
                   json_extract(i.payload, '$.idempotencyKey')
        WHERE i.type = 'fact.side_effect_intent'
          AND d.seq IS NULL`,
    )
    .all();
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

  const running = db
    .query<RunningRow, []>(
      `SELECT run_id, version, current_node
         FROM run_state
        WHERE status = 'running'
          AND NOT EXISTS (
            SELECT 1 FROM imported_runs i WHERE i.run_id = run_state.run_id AND i.adopted_at IS NULL
          )`,
    )
    .all();
  const requeuePayloads = new Map<string, string>();
  for (const row of running) {
    const payload: { prevNode?: string; lastAliveAt?: number } = {};
    if (row.current_node != null) payload.prevNode = row.current_node;
    if (opts?.priorHeartbeatAt != null) payload.lastAliveAt = opts.priorHeartbeatAt;
    requeuePayloads.set(row.run_id, JSON.stringify(payload));
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Quarantine orphan runs (only those currently in a non-terminal, non-quarantined state).
    for (const [runId, _seqs] of quarantined) {
      const ts = now();
      const stateRow = db
        .query<{ version: number; status: string; next_seq: number; imported: number }, [string]>(
          `SELECT version, status, next_seq,
                  EXISTS (SELECT 1 FROM imported_runs i
                           WHERE i.run_id = run_state.run_id AND i.adopted_at IS NULL) AS imported
             FROM run_state WHERE run_id = ?`,
        )
        .get(runId);
      if (stateRow == null) continue;
      if (
        stateRow.status === "completed" ||
        stateRow.status === "cancelled" ||
        stateRow.status === "halted" ||
        stateRow.status === "quarantined" ||
        // An imported run's orphans were the source's concern — never quarantine
        // (it would mutate the verbatim status of an inert, inspect-only run).
        stateRow.imported === 1
      ) {
        continue;
      }

      const seq = bumpSeq(db, runId);
      db.query(
        `INSERT INTO events (run_id, seq, type, writer, payload, ts)
           VALUES (?, ?, 'fact.run_quarantined', 'daemon', ?, ?)`,
      ).run(runId, seq, quarantinePayloads.get(runId)!, ts);
      // Leave last_applied_seq alone: sweep doesn't fold operator
      // intents, so it can't pretend they've been applied. Advancing
      // the watermark past, e.g., a pre-crash intent.cancel_requested
      // would silently drop it from the next executor fold.
      db.query(
        `UPDATE run_state SET
             status = 'quarantined',
             current_node = NULL,
             node_started_at = NULL,
             dispatch_started_at = NULL,
             version = version + 1,
             updated_at = ?
           WHERE run_id = ?`,
      ).run(ts, runId);
    }

    // Requeue runs still in 'running'. Re-read status here (inside the txn)
    // because the quarantine loop above may have moved some of them.
    for (const row of running) {
      const current = db
        .query<{ status: string; dispatch_started_at: number | null }, [string]>(
          "SELECT status, dispatch_started_at FROM run_state WHERE run_id = ?",
        )
        .get(row.run_id);
      if (current == null || current.status !== "running") continue;
      const ts = now();
      const seq = bumpSeq(db, row.run_id);
      db.query(
        `INSERT INTO events (run_id, seq, type, writer, payload, ts)
           VALUES (?, ?, 'fact.run_requeued_after_crash', 'daemon', ?, ?)`,
      ).run(row.run_id, seq, requeuePayloads.get(row.run_id) ?? "{}", ts);
      // Sweep bypasses the reducer, so the activeMs credit logic in
      // applyFact for fact.run_requeued_after_crash doesn't fire here.
      // Mirror it in SQL: when priorHeartbeatAt is set and strictly
      // after dispatchStartedAt, credit the pre-crash span. Otherwise
      // drop it (heartbeat unavailable or stale).
      const lastAlive = opts?.priorHeartbeatAt;
      let activeMsDelta = 0;
      if (
        typeof lastAlive === "number" &&
        current.dispatch_started_at != null &&
        lastAlive > current.dispatch_started_at
      ) {
        activeMsDelta = lastAlive - current.dispatch_started_at;
      }
      // Preserve current_node so the executor resumes on the in-flight node
      // instead of re-emitting fact.run_started and re-running the workflow
      // from the start node. Partial-side-effect safety is covered by the
      // orphan quarantine pass above; rerun-from-start was never the
      // intended recovery semantics.
      db.query(
        `UPDATE run_state SET
             status = 'queued',
             node_started_at = NULL,
             dispatch_started_at = NULL,
             ready_at = ?,
             version = version + 1,
             updated_at = ?,
             metrics = json_set(metrics, '$.activeMs',
                                COALESCE(json_extract(metrics, '$.activeMs'), 0) + ?)
           WHERE run_id = ?`,
      ).run(ts, ts, activeMsDelta, row.run_id);
      requeued.push(row.run_id);
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    requeued,
    quarantined: Array.from(quarantined.keys()),
  };
}

function bumpSeq(db: Database, runId: string): number {
  const row = db
    .query<{ seq: number }, [string]>(
      `UPDATE run_state
          SET next_seq = next_seq + 1
        WHERE run_id = ?
       RETURNING next_seq - 1 AS seq`,
    )
    .get(runId);
  if (row == null) throw new Error(`run_state missing for ${runId}`);
  return row.seq;
}
