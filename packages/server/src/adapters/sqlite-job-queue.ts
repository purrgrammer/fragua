// SQLite-backed implementation of `JobQueue`. The daemon owns this file;
// `swarm run` (the CLI client) never opens the DB directly — it POSTs to
// the daemon, which persists on its behalf.
//
// Design choices:
// - Bun's built-in `bun:sqlite` module (no dependency). Synchronous API
//   wrapped in async signatures to match the port.
// - WAL mode so future readers (a health endpoint counting queued rows,
//   a web UI polling `/jobs`) don't block writers.
// - `claimNext` uses SQLite's `UPDATE … RETURNING` (≥3.35, Bun ships
//   3.45+) to transition `queued` → `running` in a single statement —
//   no reader-then-writer race between two scheduler ticks.
// - Schema bumps are additive-only for now (`ALTER TABLE`), no migration
//   framework. When we add `retry_count` or `leased_until` we'll switch
//   to a pragma_user_version check.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EnqueueInput, JobListFilter, JobQueue, JobRow } from "../ports.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL UNIQUE,
  workflow         TEXT NOT NULL,
  input_json       TEXT,
  model            TEXT,
  status           TEXT NOT NULL CHECK (status IN ('queued','running','success','failed','canceled')),
  priority         INTEGER NOT NULL DEFAULT 0,
  enqueued_at      TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  child_pid        INTEGER,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_priority
  ON jobs(status, priority DESC, enqueued_at ASC);

CREATE INDEX IF NOT EXISTS idx_jobs_run_id
  ON jobs(run_id);
`;

/** Internal DB row shape — columns mirror the schema 1:1 (snake_case). */
interface JobDbRow {
  id: string;
  run_id: string;
  workflow: string;
  input_json: string | null;
  model: string | null;
  status: JobRow["status"];
  priority: number;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  child_pid: number | null;
  error: string | null;
}

function rowToJob(row: JobDbRow): JobRow {
  const job: JobRow = {
    id: row.id,
    runId: row.run_id,
    workflow: row.workflow,
    status: row.status,
    priority: row.priority,
    enqueuedAt: row.enqueued_at,
  };
  if (row.input_json !== null) job.inputJson = row.input_json;
  if (row.model !== null) job.model = row.model;
  if (row.started_at !== null) job.startedAt = row.started_at;
  if (row.completed_at !== null) job.completedAt = row.completed_at;
  if (row.child_pid !== null) job.childPid = row.child_pid;
  if (row.error !== null) job.error = row.error;
  return job;
}

/** Generate a run id matching the format used by the in-process `swarm
 * run` path so directories under `.swarm/runs/` look the same either
 * way. Callers can override by passing `runId` to `enqueue`. */
function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SqliteJobQueueOptions {
  /** Path to the SQLite file. Usually `.swarm/daemon/queue.db`.
   * The parent directory is created on open. Use `:memory:` for tests. */
  dbPath: string;
}

export function createSqliteJobQueue(opts: SqliteJobQueueOptions): JobQueue {
  const { dbPath } = opts;
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  // WAL allows concurrent readers + a single writer without blocking.
  // NORMAL sync is a good speed/durability trade for a local queue.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);

  // Prepared statements — prepared once, reused. Bun's `bun:sqlite` caches
  // query plans so this is pure ergonomics, but it's also the idiomatic
  // pattern and keeps the hot-path readable.
  const stmts = {
    insert: db.prepare<
      JobDbRow,
      [string, string, string, string | null, string | null, number, string]
    >(
      `INSERT INTO jobs (id, run_id, workflow, input_json, model, status, priority, enqueued_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
       RETURNING *`,
    ),
    getById: db.prepare<JobDbRow, [string]>(`SELECT * FROM jobs WHERE id = ?`),
    listAll: db.prepare<JobDbRow, [number]>(
      `SELECT * FROM jobs ORDER BY enqueued_at DESC LIMIT ?`,
    ),
    listByStatus: db.prepare<JobDbRow, [string, number]>(
      `SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, enqueued_at ASC LIMIT ?`,
    ),
    claim: db.prepare<JobDbRow, [string]>(
      `UPDATE jobs
         SET status = 'running', started_at = ?
       WHERE id = (
         SELECT id FROM jobs
          WHERE status = 'queued'
          ORDER BY priority DESC, enqueued_at ASC
          LIMIT 1
       )
       RETURNING *`,
    ),
    markRunning: db.prepare<undefined, [number, string]>(
      `UPDATE jobs SET child_pid = ? WHERE id = ? AND status = 'running'`,
    ),
    markTerminal: db.prepare<undefined, [string, string, string | null, string]>(
      `UPDATE jobs
         SET status = ?, completed_at = ?, error = ?, child_pid = NULL
       WHERE id = ? AND status = 'running'`,
    ),
    deleteQueued: db.prepare<undefined, [string]>(
      `DELETE FROM jobs WHERE id = ? AND status = 'queued'`,
    ),
    runningJobs: db.prepare<JobDbRow, []>(
      `SELECT * FROM jobs WHERE status = 'running' ORDER BY enqueued_at ASC`,
    ),
    count: db.prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM jobs WHERE status = ?`,
    ),
  };

  return {
    async enqueue(input: EnqueueInput): Promise<JobRow> {
      const id = input.id ?? crypto.randomUUID();
      const runId = input.runId ?? generateRunId();
      const priority = input.priority ?? 0;
      const enqueuedAt = new Date().toISOString();
      const row = stmts.insert.get(
        id,
        runId,
        input.workflow,
        input.inputJson ?? null,
        input.model ?? null,
        priority,
        enqueuedAt,
      );
      if (!row) {
        // Unique constraint violation would throw above; reaching here means
        // RETURNING yielded nothing, which SQLite doesn't normally do for INSERT.
        throw new Error(`enqueue: insert returned no row for job ${id}`);
      }
      return rowToJob(row);
    },

    async get(jobId: string): Promise<JobRow | undefined> {
      const row = stmts.getById.get(jobId);
      return row ? rowToJob(row) : undefined;
    },

    async list(filter: JobListFilter = {}): Promise<JobRow[]> {
      const limit = filter.limit ?? 50;
      const rows = filter.status !== undefined ? stmts.listByStatus.all(filter.status, limit) : stmts.listAll.all(limit);
      return rows.map(rowToJob);
    },

    async claimNext(): Promise<JobRow | undefined> {
      const now = new Date().toISOString();
      const row = stmts.claim.get(now);
      return row ? rowToJob(row) : undefined;
    },

    async markRunning(jobId: string, childPid: number): Promise<void> {
      stmts.markRunning.run(childPid, jobId);
    },

    async markTerminal(
      jobId: string,
      status: "success" | "failed" | "canceled",
      error?: string,
    ): Promise<void> {
      const now = new Date().toISOString();
      stmts.markTerminal.run(status, now, error ?? null, jobId);
    },

    async delete(jobId: string): Promise<void> {
      const result = stmts.deleteQueued.run(jobId);
      // Bun.sqlite returns { changes, lastInsertRowid }. 0 changes means
      // either the id doesn't exist or the row wasn't queued — both are
      // errors from the caller's perspective.
      if (result.changes === 0) {
        // Distinguish "not found" from "wrong status" so the HTTP layer
        // can return 404 vs 409. Cheap extra round-trip; the caller
        // already knew the id.
        const existing = stmts.getById.get(jobId);
        if (!existing) throw new Error(`delete: job ${jobId} not found`);
        throw new Error(`delete: job ${jobId} is ${existing.status}, only queued rows can be deleted`);
      }
    },

    async runningJobs(): Promise<JobRow[]> {
      return stmts.runningJobs.all().map(rowToJob);
    },

    async count(status): Promise<number> {
      const row = stmts.count.get(status);
      return row?.n ?? 0;
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
