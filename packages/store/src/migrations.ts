import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/** Thrown inside a migration step's transaction body when
 * `foreign_key_check` reports violations. Carries the raw rows so the
 * catch site can format the message — keeps JSON.stringify out of the
 * txn body per AGENTS.md ground rule #10 / invariant I1. */
class FkViolationError extends Error {
  constructor(public readonly violations: { table: string; rowid: number; parent: string; fkid: number }[]) {
    super("fk-violation");
  }
}

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
  [4, MIGRATION_004_LOCAL_WORKFLOW_SCOPE()],
  [5, MIGRATION_005_CONVERSATION_KIND()],
  [6, MIGRATION_006_SCHEDULES()],
  [7, MIGRATION_007_DROP_CONVERSATION_KIND()],
  [8, MIGRATION_008_AUTO_WAKE_UNIFICATION()],
  [9, MIGRATION_009_SUBRUN_COLUMNS()],
  [10, MIGRATION_010_RUNNING_CHILDREN_STATUS()],
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
        // foreign_key_check runs INSIDE the transaction, before the
        // schema_version bump, so a violation rolls the whole step
        // back. Putting it outside would commit a half-migrated state
        // (schema_version advanced, but FK violations linger) —
        // exactly the failure mode the v8 migration tripped before
        // defensive orphan vacuuming landed. The throw carries the raw
        // violations on the error so the catch site can format the
        // message — keeps JSON.stringify out of the txn body (I1).
        try {
          db.transaction(() => {
            db.exec(sql);
            const violations = db
              .query<{ table: string; rowid: number; parent: string; fkid: number }, []>("PRAGMA foreign_key_check")
              .all();
            if (violations.length > 0) {
              throw new FkViolationError(violations);
            }
            db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(next);
          })();
        } catch (err) {
          if (err instanceof FkViolationError) {
            throw new Error(`migration v${v} → v${next} left FK violations: ${JSON.stringify(err.violations)}`);
          }
          throw err;
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

/**
 * v3 → v4: widen `workflow_scope` CHECK to include 'local'.
 *
 * SQLite has no `ALTER TABLE … DROP CONSTRAINT`, so the CHECK update
 * goes through a table rebuild. `migrate()` toggles `foreign_keys =
 * OFF` around each step and runs `foreign_key_check` after commit.
 *
 * No data changes — existing rows already match the new CHECK
 * (which is a strict superset of the v3 enum).
 */
function MIGRATION_004_LOCAL_WORKFLOW_SCOPE(): string {
  return `
    CREATE TABLE run_state_v4 (
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
      workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v4 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha, branch
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha, branch
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_cwd;

    DROP TABLE run_state;
    ALTER TABLE run_state_v4 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
  `;
}

/**
 * v4 → v5: conversation runs as a kind.
 *
 * - `run_state` gains a `kind` discriminator
 *   ('workflow' | 'conversation'); existing rows default to 'workflow'.
 * - `workflow_sha` becomes nullable so conversation runs can carry
 *   `NULL` (they have no DOT document). Workflow runs continue to
 *   require a non-NULL workflow_sha; the invariant is enforced at the
 *   writer (enqueueRun), not by CHECK — SQLite can't express
 *   conditional NOT NULL.
 * - Parent linkage columns (`parent_run_id`, `parent_node_id`,
 *   `parent_iteration`) anchor sub-agent runs back to the codergen
 *   iteration that spawned them. Foreign-key cascade is SET NULL so
 *   GC'ing a parent leaves the child as a free-standing run.
 * - New partial index `idx_run_state_parent` covers parent_run_id
 *   lookups (orphan-child sweep, listChildRunIds).
 *
 * SQLite has no `ALTER TABLE … DROP NOT NULL`, so the column shape
 * change goes through a table rebuild. Indexes recreate identically
 * plus the new partial parent index.
 */
function MIGRATION_005_CONVERSATION_KIND(): string {
  return `
    CREATE TABLE run_state_v5 (
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

    INSERT INTO run_state_v5 (
      run_id, version, status, kind, current_node, workflow_sha,
      parent_run_id, parent_node_id, parent_iteration,
      schema_version, routing, metrics, next_seq, last_applied_seq,
      priority, enqueued_at, ready_at, node_started_at, dispatch_started_at,
      updated_at, title, cwd, workflow_name, workflow_scope, workflow_path,
      base_git_sha, branch
    )
    SELECT
      run_id, version, status, 'workflow' AS kind, current_node, workflow_sha,
      NULL AS parent_run_id, NULL AS parent_node_id, NULL AS parent_iteration,
      schema_version, routing, metrics, next_seq, last_applied_seq,
      priority, enqueued_at, ready_at, node_started_at, dispatch_started_at,
      updated_at, title, cwd, workflow_name, workflow_scope, workflow_path,
      base_git_sha, branch
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_cwd;

    DROP TABLE run_state;
    ALTER TABLE run_state_v5 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
    CREATE INDEX idx_run_state_parent
      ON run_state(parent_run_id) WHERE parent_run_id IS NOT NULL;
  `;
}

/**
 * v5 → v6: scheduled runs (docs/proposals/scheduled-runs.md).
 *
 * - `run_state` gains nullable `schedule_id TEXT` (no FK by design —
 *   schedule deletion is hard DELETE while run lineage persists).
 * - New `schedules` table holds `(workflow_ref, cwd, interval_ms,
 *   optional input)` triples with a `next_fire_at` cursor.
 *
 * The column add is a plain ALTER (run_state's generated columns
 * don't block adding a non-generated nullable column).
 */
function MIGRATION_006_SCHEDULES(): string {
  return `
    ALTER TABLE run_state ADD COLUMN schedule_id TEXT;

    CREATE INDEX idx_runs_by_schedule
      ON run_state(schedule_id)
      WHERE schedule_id IS NOT NULL;

    CREATE TABLE schedules (
      id              TEXT PRIMARY KEY,
      workflow_ref    TEXT NOT NULL,
      cwd             TEXT NOT NULL,
      interval_ms     INTEGER NOT NULL,
      interval_text   TEXT NOT NULL,
      input           TEXT,
      overlap_policy  TEXT NOT NULL DEFAULT 'skip'
                      CHECK (overlap_policy IN ('skip','queue','concurrent')),
      next_fire_at    INTEGER NOT NULL,
      last_fire_at    INTEGER,
      last_run_id     TEXT,
      paused_at       INTEGER,
      created_at      INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX idx_schedules_due
      ON schedules(next_fire_at)
      WHERE paused_at IS NULL;
    CREATE INDEX idx_schedules_cwd ON schedules(cwd);
  `;
}

/**
 * v6 → v7: drop the v5 conversation-run scaffolding.
 *
 * Sub-agents are not runs. They're a tool implementation that emits
 * onto the parent's stream with a `subagent_id` discriminator. The
 * `kind` discriminator, the parent linkage columns
 * (`parent_run_id`/`parent_node_id`/`parent_iteration`), and the
 * `idx_run_state_parent` index are removed; `workflow_sha` returns to
 * `NOT NULL` (every run has a workflow document again).
 *
 * Existing `kind='conversation'` rows are deleted before the rebuild —
 * they're scaffolding from the abandoned design and have no
 * recoverable state. The rebuild preserves the `schedule_id` column
 * added in v6.
 */
function MIGRATION_007_DROP_CONVERSATION_KIND(): string {
  return `
    DELETE FROM run_state WHERE kind = 'conversation';

    CREATE TABLE run_state_v7 (
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
      workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      schedule_id TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v7 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_cwd;
    DROP INDEX IF EXISTS idx_run_state_parent;
    DROP INDEX IF EXISTS idx_runs_by_schedule;

    DROP TABLE run_state;
    ALTER TABLE run_state_v7 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
    CREATE INDEX idx_runs_by_schedule
      ON run_state(schedule_id)
      WHERE schedule_id IS NOT NULL;
  `;
}

/**
 * v7 → v8: pause unification — auto-wake family.
 *
 * Stage 2 of `docs/proposals/recoverable-budget-pause.md`. Three
 * coupled changes:
 *
 *   1. CHECK rebuild: drop `paused_provider_retry` / `paused_retry`,
 *      add `paused_auto`.
 *   2. Delete in-flight runs in the legacy auto-wake states
 *      (pre-release, no prior-state compat — AGENTS.md ground rule
 *      #11). Cascades manually to events / messages / artifacts /
 *      blobs since `events` has no FK to `run_state`.
 *   3. Retire `fact.run_paused_retry` from the historical event log.
 *      Stage-1 chose payload rewrites; here we delete the rows
 *      because surviving runs went through (1) above already, so any
 *      `fact.run_paused_retry` left in `events` belongs to a deleted
 *      run.
 *
 * The `policy` field on `fact.run_paused{reason:"provider_error"}`
 * payloads from past runs is not rewritten — that field becomes
 * unused but doesn't break the projection (the new reducer keys off
 * `reason` alone). Provider auto-retry runs in flight are gone via
 * (2) above.
 */
/**
 * v8 → v9: parallel sub-runs (P1.1 of `docs/proposals/parallel.md`).
 *
 * Adds the additive sub-run linkage columns on `run_state`:
 *
 *   - `parent_run_id`             — FK to `run_state.run_id`, ON DELETE
 *                                   SET NULL (matches earlier child-run
 *                                   cascade pattern; parent GC leaves the
 *                                   sub-run as a free-standing row whose
 *                                   own GC is independent).
 *   - `parent_node_id`            — component node id on the parent that
 *                                   fanned out into this sub-run.
 *   - `parallel_index`            — sub-run's slot in the fan-out (0..N-1).
 *   - `subgraph_root_node_id`     — root of the parent-graph slice the
 *                                   sub-run dispatches through.
 *   - `subgraph_terminal_node_id` — fan_in node where the sub-run
 *                                   converges. The sub-run terminates
 *                                   before entering it; the parent's
 *                                   collect phase reads sub-run outcomes
 *                                   on the fan_in turn.
 *
 * Plus a partial index `idx_run_state_parent` covering
 * `parent_run_id` lookups (sweep, cancel propagation, cost rollup).
 *
 * All columns are nullable; existing rows keep NULL across the board
 * (they're top-level runs). The CHECK constraint on `status` is NOT
 * touched here — P1.2 adds `running_children` via its own table rebuild.
 *
 * `migrate()` runs each step with `foreign_keys = OFF`, then
 * `foreign_key_check` verifies consistency before commit. ADD COLUMN
 * with REFERENCES is fine in this mode; new rows pass trivially
 * because every existing `parent_run_id` is NULL.
 */
function MIGRATION_009_SUBRUN_COLUMNS(): string {
  return `
    ALTER TABLE run_state ADD COLUMN parent_run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL;
    ALTER TABLE run_state ADD COLUMN parent_node_id TEXT;
    ALTER TABLE run_state ADD COLUMN parallel_index INTEGER;
    ALTER TABLE run_state ADD COLUMN subgraph_root_node_id TEXT;
    ALTER TABLE run_state ADD COLUMN subgraph_terminal_node_id TEXT;

    CREATE INDEX idx_run_state_parent
      ON run_state(parent_run_id) WHERE parent_run_id IS NOT NULL;
  `;
}

/**
 * v9 → v10: parallel sub-runs (P1.2 of `docs/proposals/parallel.md`).
 *
 * Adds `running_children` to `run_state.status` CHECK. A parent run in
 * this status has fanned out into N sub-runs and is waiting for them to
 * converge — it is NOT paused (worktree + provisioner state stay live)
 * and NOT queued (claim loop must not re-pick it). The wake-pending
 * sweep transitions it back to `queued` (collect phase) when every
 * sub-run reaches a terminal status.
 *
 * SQLite has no `ALTER TABLE … ADD CHECK`, so the status CHECK update
 * goes through a table rebuild. Indexes recreate identically. The v9
 * sub-run linkage columns and `idx_run_state_parent` are preserved.
 */
function MIGRATION_010_RUNNING_CHILDREN_STATUS(): string {
  return `
    CREATE TABLE run_state_v10 (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','running_children','paused','paused_hitl','paused_auto',
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
      workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      schedule_id TEXT,
      parent_run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL,
      parent_node_id TEXT,
      parallel_index INTEGER,
      subgraph_root_node_id TEXT,
      subgraph_terminal_node_id TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v10 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id,
      parent_run_id, parent_node_id, parallel_index,
      subgraph_root_node_id, subgraph_terminal_node_id
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id,
      parent_run_id, parent_node_id, parallel_index,
      subgraph_root_node_id, subgraph_terminal_node_id
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_cwd;
    DROP INDEX IF EXISTS idx_runs_by_schedule;
    DROP INDEX IF EXISTS idx_run_state_parent;

    DROP TABLE run_state;
    ALTER TABLE run_state_v10 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
    CREATE INDEX idx_runs_by_schedule
      ON run_state(schedule_id)
      WHERE schedule_id IS NOT NULL;
    CREATE INDEX idx_run_state_parent
      ON run_state(parent_run_id)
      WHERE parent_run_id IS NOT NULL;
  `;
}

function MIGRATION_008_AUTO_WAKE_UNIFICATION(): string {
  return `
    -- (2) drop in-flight legacy auto-wake runs and cascade their
    --     dependent rows. events / messages / artifacts have FKs to
    --     run_state with ON DELETE CASCADE, but FKs are OFF during
    --     migration so we cascade explicitly.
    DELETE FROM events
      WHERE run_id IN (SELECT run_id FROM run_state
                       WHERE status IN ('paused_provider_retry', 'paused_retry'));
    DELETE FROM messages
      WHERE run_id IN (SELECT run_id FROM run_state
                       WHERE status IN ('paused_provider_retry', 'paused_retry'));
    DELETE FROM artifacts
      WHERE run_id IN (SELECT run_id FROM run_state
                       WHERE status IN ('paused_provider_retry', 'paused_retry'));
    DELETE FROM run_state
      WHERE status IN ('paused_provider_retry', 'paused_retry');

    -- Defensive orphan vacuum. Earlier migrations (notably v6 → v7's
    -- DELETE FROM run_state WHERE kind='conversation', plus any past
    -- crash-cleanup that ran with FKs off) could have left events /
    -- messages / artifacts whose run_id no longer exists in run_state.
    -- foreign_key_check at the end of this step would surface those
    -- as v8 violations even though they predate v8. Sweep them now.
    DELETE FROM events     WHERE run_id NOT IN (SELECT run_id FROM run_state);
    DELETE FROM messages   WHERE run_id NOT IN (SELECT run_id FROM run_state);
    DELETE FROM artifacts  WHERE run_id NOT IN (SELECT run_id FROM run_state);

    -- Orphan blobs: ref-counted by artifacts via blob_sha. Drop
    -- unreferenced rows so foreign_key_check passes after the migration.
    DELETE FROM blobs
      WHERE sha256 NOT IN (SELECT DISTINCT blob_sha FROM artifacts);

    -- (3) retire the historical fact-type. Surviving runs (after the
    --     deletes above) must not carry it.
    DELETE FROM events WHERE type = 'fact.run_paused_retry';

    -- (1) CHECK rebuild — table swap. Same shape as v7.
    CREATE TABLE run_state_v8 (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','paused','paused_hitl','paused_auto',
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
      workflow_scope TEXT CHECK (workflow_scope IN ('global','local','path','ephemeral')),
      workflow_path TEXT,
      base_git_sha TEXT,
      branch TEXT,
      schedule_id TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v8 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, dispatch_started_at, updated_at, title,
      cwd, workflow_name, workflow_scope, workflow_path, base_git_sha,
      branch, schedule_id
    FROM run_state;

    DROP INDEX IF EXISTS idx_run_state_queue;
    DROP INDEX IF EXISTS idx_run_state_status;
    DROP INDEX IF EXISTS idx_run_state_workflow;
    DROP INDEX IF EXISTS idx_run_state_updated;
    DROP INDEX IF EXISTS idx_run_state_cwd;
    DROP INDEX IF EXISTS idx_runs_by_schedule;

    DROP TABLE run_state;
    ALTER TABLE run_state_v8 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC)
      WHERE status = 'queued';
    CREATE INDEX idx_run_state_status   ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated  ON run_state(updated_at);
    CREATE INDEX idx_run_state_cwd      ON run_state(cwd);
    CREATE INDEX idx_runs_by_schedule
      ON run_state(schedule_id)
      WHERE schedule_id IS NOT NULL;
  `;
}
