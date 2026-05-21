// v5 → v6 migration: scheduled-runs.
//
// Verifies the migration adds the `schedules` table, adds
// `run_state.schedule_id`, and creates the documented partial indexes
// without dropping any existing run rows.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrations.ts";
import { applyCreationPragmas, applyPragmas } from "../src/pragmas.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  applyCreationPragmas(db);
  applyPragmas(db);
  return db;
}

/** Build a fresh v5-shaped DB from raw SQL so a subsequent
 *  `migrate(db)` walks the v5 → v6 step (and v6 → v7) cleanly. We
 *  can't bootstrap-then-revert because v7 drops the v5 conversation
 *  scaffolding (`kind` / `parent_*` columns), so a "current then
 *  rewind" path no longer reproduces the v5 column shape. */
function pinV5(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
    INSERT INTO schema_version (id, version) VALUES (1, 5);
    CREATE TABLE workflows (
      sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE run_state (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','paused','paused_hitl','paused_provider_retry','paused_retry',
        'completed','cancelled','halted','quarantined'
      )),
      kind TEXT NOT NULL DEFAULT 'workflow' CHECK (kind IN ('workflow','conversation')),
      current_node TEXT,
      workflow_sha TEXT REFERENCES workflows(sha),
      parent_run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL,
      parent_node_id TEXT,
      parent_iteration INTEGER,
      schema_version INTEGER NOT NULL,
      routing TEXT NOT NULL CHECK (length(routing) < 8192),
      metrics TEXT NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 1,
      last_applied_seq INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL,
      ready_at INTEGER NOT NULL,
      node_started_at INTEGER,
      dispatch_started_at INTEGER,
      updated_at INTEGER NOT NULL,
      title TEXT,
      cwd TEXT,
      workflow_name TEXT,
      workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;
    -- Auxiliary v5 tables that the v8 migration touches when cascading
    -- deletes for legacy auto-wake runs. Kept minimal — schemas mirror
    -- schema.sql at v5 but only the columns the migration reads.
    CREATE TABLE events (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      writer TEXT NOT NULL CHECK (writer IN ('daemon','web')),
      payload TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE messages (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL,
      role TEXT,
      node_id TEXT,
      iteration INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      PRIMARY KEY (run_id, ordinal)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE artifacts (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL,
      blob_sha TEXT NOT NULL REFERENCES blobs(sha256),
      mime TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, key)
    ) STRICT, WITHOUT ROWID;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

describe("v5 → v6 schedules migration", () => {
  test("adds schedules table with the documented CHECK on overlap_policy", () => {
    const db = freshDb();
    pinV5(db);
    migrate(db);

    const tbl = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schedules'")
      .get();
    expect(tbl?.name).toBe("schedules");

    db.exec(`
      INSERT INTO schedules (id, workflow_ref, cwd, interval_ms, interval_text, overlap_policy, next_fire_at, created_at)
      VALUES ('sch_ok', 'wf', '/r', 3600000, '1h', 'skip', 0, 0)
    `);
    expect(() =>
      db.exec(`
        INSERT INTO schedules (id, workflow_ref, cwd, interval_ms, interval_text, overlap_policy, next_fire_at, created_at)
        VALUES ('sch_bad', 'wf', '/r', 3600000, '1h', 'wat', 0, 0)
      `),
    ).toThrow();
    db.close();
  });

  test("adds run_state.schedule_id column without dropping existing rows", () => {
    const db = freshDb();
    pinV5(db);

    db.exec(`
      INSERT INTO workflows (sha, name, dot_source, created_at) VALUES ('wf1', 'n', 'digraph G {}', 0);
      INSERT INTO run_state (
        run_id, version, status, kind, current_node, workflow_sha,
        parent_run_id, parent_node_id, parent_iteration,
        schema_version, routing, metrics, next_seq, last_applied_seq, priority, enqueued_at, ready_at, updated_at
      ) VALUES ('run_1', 1, 'queued', 'workflow', NULL, 'wf1', NULL, NULL, NULL, 5, '{}', '{}', 1, 0, 0, 100, 100, 100);
    `);

    migrate(db);

    const row = db
      .query<{ run_id: string; schedule_id: string | null }, []>(
        "SELECT run_id, schedule_id FROM run_state WHERE run_id = 'run_1'",
      )
      .get();
    expect(row?.run_id).toBe("run_1");
    expect(row?.schedule_id).toBeNull();
    db.close();
  });

  test("creates idx_schedules_due partial index and idx_runs_by_schedule partial index", () => {
    const db = freshDb();
    pinV5(db);
    migrate(db);

    const idxRows = db
      .query<{ name: string; sql: string | null }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('idx_schedules_due','idx_runs_by_schedule')",
      )
      .all();
    const names = idxRows.map((r) => r.name).sort();
    expect(names).toEqual(["idx_runs_by_schedule", "idx_schedules_due"]);
    expect(idxRows.find((r) => r.name === "idx_schedules_due")?.sql).toMatch(/paused_at IS NULL/);
    expect(idxRows.find((r) => r.name === "idx_runs_by_schedule")?.sql).toMatch(/schedule_id IS NOT NULL/);
    db.close();
  });
});
