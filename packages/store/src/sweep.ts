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
 * paused_hitl and quarantined runs are not touched; they are preserved
 * exactly.
 */
export function startupSweep(db: Database, now: () => number): SweepResult {
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
    quarantinePayloads.set(
      runId,
      JSON.stringify({ reason: "orphan_side_effect", orphanedIntents: seqs }),
    );
  }

  const running = db
    .query<RunningRow, []>(
      `SELECT run_id, version, current_node
         FROM run_state
        WHERE status = 'running'`,
    )
    .all();
  const requeuePayloads = new Map<string, string>();
  for (const row of running) {
    requeuePayloads.set(
      row.run_id,
      JSON.stringify(row.current_node != null ? { prevNode: row.current_node } : {}),
    );
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Quarantine orphan runs (only those currently in a non-terminal, non-quarantined state).
    for (const [runId, _seqs] of quarantined) {
      const ts = now();
      const stateRow = db
        .query<
          { version: number; status: string; next_seq: number },
          [string]
        >(
          "SELECT version, status, next_seq FROM run_state WHERE run_id = ?",
        )
        .get(runId);
      if (stateRow == null) continue;
      if (
        stateRow.status === "completed" ||
        stateRow.status === "cancelled" ||
        stateRow.status === "halted" ||
        stateRow.status === "quarantined"
      ) {
        continue;
      }

      const seq = bumpSeq(db, runId);
      db
        .query(
          `INSERT INTO events (run_id, seq, type, writer, payload, ts)
           VALUES (?, ?, 'fact.run_quarantined', 'daemon', ?, ?)`,
        )
        .run(runId, seq, quarantinePayloads.get(runId)!, ts);
      db
        .query(
          `UPDATE run_state SET
             status = 'quarantined',
             current_node = NULL,
             node_started_at = NULL,
             version = version + 1,
             last_applied_seq = ?,
             updated_at = ?
           WHERE run_id = ?`,
        )
        .run(seq, ts, runId);
    }

    // Requeue runs still in 'running'. Re-read status here (inside the txn)
    // because the quarantine loop above may have moved some of them.
    for (const row of running) {
      const current = db
        .query<{ status: string }, [string]>(
          "SELECT status FROM run_state WHERE run_id = ?",
        )
        .get(row.run_id);
      if (current == null || current.status !== "running") continue;
      const ts = now();
      const seq = bumpSeq(db, row.run_id);
      db
        .query(
          `INSERT INTO events (run_id, seq, type, writer, payload, ts)
           VALUES (?, ?, 'fact.run_requeued_after_crash', 'daemon', ?, ?)`,
        )
        .run(
          row.run_id,
          seq,
          requeuePayloads.get(row.run_id) ?? "{}",
          ts,
        );
      db
        .query(
          `UPDATE run_state SET
             status = 'queued',
             current_node = NULL,
             node_started_at = NULL,
             ready_at = ?,
             version = version + 1,
             last_applied_seq = ?,
             updated_at = ?
           WHERE run_id = ?`,
        )
        .run(ts, seq, ts, row.run_id);
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
