import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Step-delta migrations applied to existing DBs. Keyed by *target*
 * version: `STEP_MIGRATIONS.get(N)` is the SQL that takes a v(N-1) DB
 * to vN.
 *
 * Fresh DBs run `schema.sql` once and pin to `CURRENT_SCHEMA_VERSION`
 * directly, skipping these. Existing DBs walk each delta in order.
 *
 * Each delta runs in its own transaction with `foreign_keys = OFF`
 * around it (table rebuilds on FK-referenced tables need it).
 * `PRAGMA foreign_key_check` after the commit verifies consistency.
 */
const STEP_MIGRATIONS: ReadonlyMap<number, string> = new Map([[2, MIGRATION_002_PAUSE_UNIFICATION()]]);

/**
 * Apply the schema to `db` and pin / advance the `schema_version` row.
 *
 * - Fresh DB (no `schema_version` row): `schema.sql` creates the
 *   current shape; pin to `CURRENT_SCHEMA_VERSION`.
 * - Existing DB at `version === CURRENT_SCHEMA_VERSION`: nothing to do.
 * - Existing DB at `version < CURRENT_SCHEMA_VERSION`: walk each step
 *   in `STEP_MIGRATIONS`, updating `schema_version` between steps.
 * - Existing DB at `version > CURRENT_SCHEMA_VERSION`: refuse
 *   (downgrade — caller must redeploy a newer daemon or restore a
 *   snapshot).
 */
export function migrate(db: Database): void {
  // Bootstrap: idempotent CREATE TABLE IF NOT EXISTS for fresh DBs;
  // no-op for existing DBs (their CREATE statements skip).
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
  })();

  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();

  if (row == null) {
    db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    return;
  }

  if (row.version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `schema downgrade refused: db has version ${row.version}, ` +
        `code expects ≤ ${CURRENT_SCHEMA_VERSION}. Re-deploy a newer ` +
        `daemon or restore an older DB snapshot.`,
    );
  }

  if (row.version < MIN_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(
      `schema drift: db has version ${row.version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
        "No migration registered from that version forward.",
    );
  }

  if (row.version === CURRENT_SCHEMA_VERSION) return;

  // Step-deltas. Foreign-key toggling is illegal inside a transaction,
  // so each step runs with `foreign_keys = OFF` outside its tx, then
  // `foreign_key_check` after commit verifies consistency.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    let v = row.version;
    while (v < CURRENT_SCHEMA_VERSION) {
      const next = v + 1;
      const sql = STEP_MIGRATIONS.get(next);
      if (sql == null) {
        throw new Error(`no step-delta registered for v${v} → v${next}`);
      }
      db.transaction(() => {
        db.exec(sql);
        db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(next);
      })();
      const violations = db
        .query<{ table: string; rowid: number; parent: string; fkid: number }, []>("PRAGMA foreign_key_check")
        .all();
      if (violations.length > 0) {
        throw new Error(`migration v${v} → v${next} left FK violations: ${JSON.stringify(violations)}`);
      }
      v = next;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v1 → v2: pause unification.
 *
 * - `run_state` CHECK loses `paused_provider_error`, gains `paused`.
 *   Existing rows in `paused_provider_error` rewrite to `paused`.
 * - `events` rewrites `fact.run_paused_provider_error` to
 *   `fact.run_paused` with `reason` discriminated by `httpStatus`:
 *   402 → `payment_required`, anything else without `policy` →
 *   `provider_error`, with `policy` → `provider_error` carrying the
 *   auto-retry chain.
 *
 * SQLite has no `ALTER TABLE … DROP CONSTRAINT`, so the status CHECK
 * change goes through a table rebuild. Indexes recreate identically.
 * Generated columns are derived from `metrics` so `INSERT … SELECT`
 * doesn't list them.
 */
function MIGRATION_002_PAUSE_UNIFICATION(): string {
  return `
    -- run_state rebuild for the new CHECK
    CREATE TABLE run_state_v2 (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','paused','paused_hitl','paused_provider_retry','paused_retry',
        'completed','cancelled','halted','quarantined'
      )),
      current_node TEXT,
      workflow_sha TEXT NOT NULL REFERENCES workflows(sha),
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
      project_id TEXT,
      base_git_sha TEXT,
      branch TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v2 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      project_id, base_git_sha, branch
    )
    SELECT
      run_id, version,
      CASE WHEN status = 'paused_provider_error' THEN 'paused' ELSE status END,
      current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      project_id, base_git_sha, branch
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_project;

    DROP TABLE run_state;
    ALTER TABLE run_state_v2 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_project  ON run_state(project_id);

    -- 402 (manual) → payment_required. Drop httpStatus (redundant: reason implies 402).
    UPDATE events
    SET type = 'fact.run_paused',
        payload = json_object(
          'reason',       'payment_required',
          'nodeId',       json_extract(payload, '$.nodeId'),
          'provider',     json_extract(payload, '$.provider'),
          'errorMessage', json_extract(payload, '$.errorMessage')
        )
    WHERE type = 'fact.run_paused_provider_error'
      AND json_extract(payload, '$.httpStatus') = 402;

    -- Other manual (400/401/403/404/413/422 + null status) → provider_error.
    UPDATE events
    SET type = 'fact.run_paused',
        payload = json_object(
          'reason',       'provider_error',
          'nodeId',       json_extract(payload, '$.nodeId'),
          'httpStatus',   json_extract(payload, '$.httpStatus'),
          'provider',     json_extract(payload, '$.provider'),
          'errorMessage', json_extract(payload, '$.errorMessage')
        )
    WHERE type = 'fact.run_paused_provider_error'
      AND json_extract(payload, '$.policy') IS NULL;

    -- Auto-retry chain (408/429/5xx/network) → provider_error with policy.
    UPDATE events
    SET type = 'fact.run_paused',
        payload = json_object(
          'reason',       'provider_error',
          'nodeId',       json_extract(payload, '$.nodeId'),
          'httpStatus',   json_extract(payload, '$.httpStatus'),
          'provider',     json_extract(payload, '$.provider'),
          'errorMessage', json_extract(payload, '$.errorMessage'),
          'policy',       json_extract(payload, '$.policy'),
          'attempt',      json_extract(payload, '$.attempt'),
          'resumeAt',     json_extract(payload, '$.resumeAt')
        )
    WHERE type = 'fact.run_paused_provider_error'
      AND json_extract(payload, '$.policy') IS NOT NULL;
  `;
}
