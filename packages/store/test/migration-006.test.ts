// v5 → v6 migration: scheduled-runs (proposal: docs/proposals/scheduled-runs.md).
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

/** Pin the DB to v5 by bootstrapping at the current version, then
 *  reverting the v5→v6 deltas (drop schedules table, the partial
 *  index, and the schedule_id column) and rewinding `schema_version`
 *  so a subsequent `migrate(db)` walks the v5→v6 step. */
function pinV5(db: Database): void {
  migrate(db);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    DROP INDEX IF EXISTS idx_runs_by_schedule;
    DROP TABLE IF EXISTS schedules;
    ALTER TABLE run_state DROP COLUMN schedule_id;
  `);
  db.exec("PRAGMA foreign_keys = ON");
  db.query("UPDATE schema_version SET version = 5 WHERE id = 1").run();
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
