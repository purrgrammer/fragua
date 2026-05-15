// v10 → v11 migration: provider credentials in the store
// (docs/proposals/provider-credentials-storage.md).
//
// Verifies the migration adds the `provider_credentials` table without
// touching any existing run/event/schedule data and pins the schema
// version to 11. Idempotent re-runs are no-ops.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrations.ts";
import { applyCreationPragmas, applyPragmas, CURRENT_SCHEMA_VERSION } from "../src/pragmas.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  applyCreationPragmas(db);
  applyPragmas(db);
  return db;
}

/** Hand-pin a v10-shaped DB so a subsequent `migrate(db)` walks v10 →
 *  v11. We can't bootstrap-then-revert because the current schema.sql
 *  is already at v11; we recreate the v10 column shape + the v10
 *  schema_version row. */
function pinV10(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
    INSERT INTO schema_version (id, version) VALUES (1, 10);
    CREATE TABLE workflows (
      sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE run_state (
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
    CREATE TABLE events (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      writer TEXT NOT NULL CHECK (writer IN ('daemon','web')),
      payload TEXT NOT NULL CHECK (length(payload) < 4096),
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE messages (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      content TEXT NOT NULL CHECK (json_valid(content) AND length(content) < 1048576),
      role TEXT GENERATED ALWAYS AS (json_extract(content, '$.role')) STORED,
      node_id TEXT,
      iteration INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT,
      PRIMARY KEY (run_id, ordinal)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE artifacts (
      run_id TEXT NOT NULL REFERENCES run_state(run_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, iteration INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL,
      blob_sha TEXT NOT NULL REFERENCES blobs(sha256),
      mime TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, node_id, iteration, key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE daemon_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL, hostname TEXT NOT NULL,
      started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
      http_url TEXT, http_port INTEGER, harness_version TEXT
    ) STRICT;
    CREATE TABLE daemon_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (length(payload) < 4096),
      ts INTEGER NOT NULL,
      run_id TEXT REFERENCES run_state(run_id) ON DELETE SET NULL
    ) STRICT;
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, workflow_ref TEXT NOT NULL, cwd TEXT NOT NULL,
      interval_ms INTEGER NOT NULL, interval_text TEXT NOT NULL,
      input TEXT,
      overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy IN ('skip','queue','concurrent')),
      next_fire_at INTEGER NOT NULL, last_fire_at INTEGER, last_run_id TEXT,
      paused_at INTEGER, created_at INTEGER NOT NULL
    ) STRICT;
  `);
  db.exec("PRAGMA foreign_keys = ON");
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return row != null;
}

function schemaVersion(db: Database): number {
  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
  if (row == null) throw new Error("schema_version missing");
  return row.version;
}

describe("migration v10 \u2192 v11", () => {
  test("adds provider_credentials table on a pinned v10 DB", () => {
    const db = freshDb();
    try {
      pinV10(db);
      expect(schemaVersion(db)).toBe(10);
      expect(tableExists(db, "provider_credentials")).toBe(false);

      migrate(db);

      expect(schemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(11);
      expect(tableExists(db, "provider_credentials")).toBe(true);

      // CHECK constraint applied: kind must be api_key | oauth.
      expect(() =>
        db
          .query(
            "INSERT INTO provider_credentials (provider, kind, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("x", "bogus", "{}", 1, 1),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      db.close();
    }
  });

  test("migration is idempotent on a fresh v11 DB", () => {
    const db = freshDb();
    try {
      // Fresh DB \u2014 schema.sql is at v11 already; `migrate()` pins to
      // CURRENT_SCHEMA_VERSION on the first call and is a no-op on the
      // second.
      migrate(db);
      expect(schemaVersion(db)).toBe(11);
      expect(tableExists(db, "provider_credentials")).toBe(true);

      migrate(db);
      expect(schemaVersion(db)).toBe(11);
      expect(tableExists(db, "provider_credentials")).toBe(true);
    } finally {
      db.close();
    }
  });
});
