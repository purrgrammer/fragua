import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Apply the schema to `db` and pin the `schema_version` row. Versions in
 * `[MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]` are accepted —
 * additive migrations run idempotently and the row is bumped to CURRENT.
 * Versions below MIN throw schema-drift; versions above CURRENT throw
 * downgrade-refused. See `pragmas.ts` for the bumping policy.
 *
 * Migrations that *rebuild* a table (DROP + RENAME) MUST run with
 * `foreign_keys=OFF` and OUTSIDE the main migration transaction —
 * SQLite cascades child deletes on `DROP TABLE` of a parent when
 * `foreign_keys=ON`, and `PRAGMA foreign_keys` inside an open
 * transaction is a silent no-op. `applyRebuildMigrations` is the
 * pre-txn step that handles those cases.
 */
export function migrate(db: Database): void {
  applyRebuildMigrations(db);

  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    applyAdditiveMigrations(db);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    if (row == null) {
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
      return;
    }
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `schema downgrade refused: db has version ${row.version}, code expects ≤ ${CURRENT_SCHEMA_VERSION}. ` +
          "Re-deploy a newer daemon or restore an older DB snapshot.",
      );
    }
    if (row.version < MIN_COMPATIBLE_SCHEMA_VERSION) {
      throw new Error(
        `schema drift: db has version ${row.version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
          "Pre-release: delete .swarm/swarm.db and restart.",
      );
    }
    if (row.version !== CURRENT_SCHEMA_VERSION) {
      // Additive bump: row was at v=N, code is at v=M (N < M, both within
      // compat range). The additive migrations above already brought the
      // schema forward; record the new version.
      db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION);
    }
  })();
}

function applyAdditiveMigrations(db: Database): void {
  // messages.content_hash + idx_messages_dedup landed without a version
  // bump because they're additive: pre-existing rows get a NULL hash
  // and the partial unique index ignores them. New writes always set
  // content_hash so dedup applies going forward.
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (!cols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE messages ADD COLUMN content_hash TEXT");
  }
}

/**
 * Rebuild migrations — DROP + RENAME on a parent table. MUST run before
 * the main migration transaction, with `foreign_keys=OFF`. SQLite
 * cascades child deletes on DROP TABLE when FKs are enabled (events,
 * messages, artifacts all reference run_state with ON DELETE CASCADE);
 * the foreign-key pragma can only be toggled outside an open
 * transaction.
 *
 * Each block is idempotent — gated on whether the target schema literal
 * already appears in the stored DDL — so a no-op on already-migrated
 * DBs.
 */
function applyRebuildMigrations(db: Database): void {
  const readDdl = (): string | null =>
    db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_state'").get()
      ?.sql ?? null;

  const runRebuild = (build: (db: Database) => void, label: string): void => {
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => build(db))();
      const violations = db.query<{ table: string; rowid: number }, []>("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`${label} rebuild left ${violations.length} foreign-key violation(s); aborting.`);
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  };

  const ddlV3 = readDdl();
  if (ddlV3 && !ddlV3.includes("'paused_provider_error'")) {
    runRebuild(rebuildRunStateForV4, "v4");
  }

  const ddlV4 = readDdl();
  if (ddlV4 && !ddlV4.includes("billed_tokens")) {
    runRebuild(rebuildRunStateForV5, "v5");
  }
}

/**
 * v3 → v4 widens the run_state.status CHECK to include
 * 'paused_provider_error'. SQLite STRICT can't ALTER a CHECK, so we
 * follow the rename-rebuild-rename dance from
 * https://sqlite.org/lang_altertable.html#otheralter (option 2).
 *
 * Caller MUST have set `PRAGMA foreign_keys=OFF` outside this txn:
 * with FKs on, `DROP TABLE run_state` cascades through the
 * `ON DELETE CASCADE` references on events/messages/artifacts and
 * silently empties them. `applyRebuildMigrations` is the only sanctioned
 * entry point.
 */
function rebuildRunStateForV4(db: Database): void {
  db.exec(`
    CREATE TABLE run_state_v4 (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','paused_hitl','paused_provider_error',
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
      updated_at INTEGER NOT NULL,
      title TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      total_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v4 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, updated_at, title
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, updated_at, title
    FROM run_state;

    DROP TABLE run_state;
    ALTER TABLE run_state_v4 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC) WHERE status = 'queued';
    CREATE INDEX idx_run_state_status ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated ON run_state(updated_at);
  `);
}

/**
 * v4 → v5 renames the generated column `total_tokens` → `billed_tokens`
 * and the JSON path it extracts (`$.totalTokens` → `$.billedTokens`).
 * The metrics JSON for every existing row is rewritten in the same
 * transaction so the new generated column has a value to extract.
 *
 * Caller MUST have set `PRAGMA foreign_keys=OFF` outside this txn — same
 * cascade trap as v4. `applyRebuildMigrations` is the only sanctioned
 * entry point.
 */
function rebuildRunStateForV5(db: Database): void {
  db.exec(`
    UPDATE run_state
       SET metrics = json_set(
                       json_remove(metrics, '$.totalTokens'),
                       '$.billedTokens',
                       COALESCE(json_extract(metrics, '$.totalTokens'), 0)
                     )
     WHERE json_extract(metrics, '$.totalTokens') IS NOT NULL
        OR json_extract(metrics, '$.billedTokens') IS NULL;

    CREATE TABLE run_state_v5 (
      run_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued','running','paused_hitl','paused_provider_error',
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
      updated_at INTEGER NOT NULL,
      title TEXT,
      total_cost_usd REAL GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
      billed_tokens INTEGER GENERATED ALWAYS AS
        (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
    ) STRICT;

    INSERT INTO run_state_v5 (
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, updated_at, title
    )
    SELECT
      run_id, version, status, current_node, workflow_sha, schema_version,
      routing, metrics, next_seq, last_applied_seq, priority, enqueued_at,
      ready_at, node_started_at, updated_at, title
    FROM run_state;

    DROP TABLE run_state;
    ALTER TABLE run_state_v5 RENAME TO run_state;

    CREATE INDEX idx_run_state_queue
      ON run_state(priority DESC, ready_at ASC) WHERE status = 'queued';
    CREATE INDEX idx_run_state_status ON run_state(status);
    CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
    CREATE INDEX idx_run_state_updated ON run_state(updated_at);
  `);
}
