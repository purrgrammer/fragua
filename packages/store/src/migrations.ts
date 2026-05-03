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
const STEP_MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [2, MIGRATION_002_PAUSE_UNIFICATION()],
  [3, MIGRATION_003_HARNESS_BY_DEFAULT()],
]);

/**
 * Apply the schema to `db` and pin / advance the `schema_version` row.
 *
 * - Fresh DB (no `schema_version` table): run `schema.sql`, pin to
 *   `CURRENT_SCHEMA_VERSION`.
 * - Existing DB at `version === CURRENT_SCHEMA_VERSION`: idempotent
 *   re-run of `schema.sql` to pick up any new `IF NOT EXISTS` indexes.
 * - Existing DB at `version < CURRENT_SCHEMA_VERSION`: walk each step
 *   in `STEP_MIGRATIONS`, then re-run `schema.sql` for new indexes.
 * - Existing DB at `version > CURRENT_SCHEMA_VERSION`: refuse
 *   (downgrade — caller must redeploy a newer daemon or restore a
 *   snapshot).
 *
 * Ordering matters: migrations run BEFORE the bootstrap re-run because
 * `schema.sql` references the post-migration column shape. Running it
 * first against a pre-migration DB fails when new indexes reference
 * columns the old schema doesn't carry.
 */
export function migrate(db: Database): void {
  const hasSchemaVersion =
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() != null;

  if (!hasSchemaVersion) {
    // Fresh DB: bootstrap the full schema and pin the current version.
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    })();
    return;
  }

  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
  if (row == null) {
    throw new Error("schema_version table exists but carries no row — DB is in an inconsistent state");
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

  // Step-deltas. Foreign-key toggling is illegal inside a transaction,
  // so each step runs with `foreign_keys = OFF` outside its tx, then
  // `foreign_key_check` after commit verifies consistency.
  if (row.version < CURRENT_SCHEMA_VERSION) {
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

  // Belt-and-suspenders: re-run the bootstrap so any `IF NOT EXISTS`
  // index/table declared in `schema.sql` but not added by a migration
  // lands on an already-migrated DB. After the column shape matches
  // `schema.sql`, this is always safe.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
  })();
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

/**
 * v2 → v3: harness-by-default.
 *
 * - `daemon_lock` gains URL columns (`http_url`, `http_port`,
 *   `harness_version`) so CLIs discover the running daemon via the DB
 *   instead of a JSON file.
 * - `run_state.project_id` and the `projects` table are removed.
 *   `run_state` gains `cwd`, `workflow_name`, `workflow_scope`,
 *   `workflow_path`. `cwd` is backfilled from `projects.root_path`
 *   joined on the old `project_id` so existing runs retain their
 *   project identifier as a path.
 *
 * SQLite has no `ALTER TABLE … DROP COLUMN` for tables with FK-
 * referenced rows under `foreign_keys = ON`, so the column drop goes
 * through a table rebuild. `migrate()` toggles `foreign_keys = OFF`
 * around each step and runs `foreign_key_check` after commit.
 */
function MIGRATION_003_HARNESS_BY_DEFAULT(): string {
  return `
    ALTER TABLE daemon_lock ADD COLUMN http_url TEXT;
    ALTER TABLE daemon_lock ADD COLUMN http_port INTEGER;
    ALTER TABLE daemon_lock ADD COLUMN harness_version TEXT;

    CREATE TABLE run_state_v3 (
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
      cwd TEXT,
      workflow_name TEXT,
      workflow_scope TEXT CHECK (workflow_scope IN ('global','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v3 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha, branch
    )
    SELECT
      r.run_id, r.version, r.status, r.current_node, r.workflow_sha, r.schema_version,
      r.routing, r.metrics, r.next_seq, r.last_applied_seq, r.priority, r.enqueued_at,
      r.ready_at, r.node_started_at, r.dispatch_started_at, r.updated_at, r.title,
      p.root_path, NULL, NULL, NULL, r.base_git_sha, r.branch
    FROM run_state r
    LEFT JOIN projects p ON p.id = r.project_id;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_project;

    DROP TABLE run_state;
    ALTER TABLE run_state_v3 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);

    DROP TABLE projects;
  `;
}
