// Migration policy — pre-release, fresh DB only.
// See packages/store/src/pragmas.ts.

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

describe("migrate — schema version handling", () => {
  test("fresh DB: stamps CURRENT_SCHEMA_VERSION on first migrate", () => {
    const db = freshDb();
    migrate(db);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("idempotent: re-running migrate on a fresh DB is a no-op", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("below MIN: throws schema-drift", () => {
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = 0").run();
    expect(() => migrate(db)).toThrow(/schema drift/i);
    db.close();
  });

  test("above CURRENT: throws downgrade-refused", () => {
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION + 100);
    expect(() => migrate(db)).toThrow(/downgrade refused/i);
    db.close();
  });
});

describe("migrate — v6 → v7 drops conversation-run scaffolding", () => {
  /** Build a minimal v6-shaped run_state table (with the v5 conversation
   *  columns + the v6 schedule_id) so we can exercise the v6 → v7 step
   *  delta. v7 deletes any `kind='conversation'` rows, drops the kind +
   *  parent_* columns, and restores `workflow_sha NOT NULL`. */
  function seedV6Db(): Database {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version (id, version) VALUES (1, 6);
      CREATE TABLE workflows (sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      INSERT INTO workflows (sha, name, dot_source, created_at) VALUES ('wf-1', 't', 'digraph {}', 0);
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
        schedule_id TEXT,
        total_cost_usd REAL GENERATED ALWAYS AS
          (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
        billed_tokens INTEGER GENERATED ALWAYS AS
          (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
      ) STRICT;
      -- Auxiliary v6 tables. v8 migration cascades deletes through
      -- events / messages / artifacts and prunes orphan blobs; this
      -- minimal seed lets the migration chain run cleanly when the
      -- test starts at v6.
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
    return db;
  }

  test("v6 → v7 deletes kind='conversation' rows; preserves workflow rows; columns are gone", () => {
    const db = seedV6Db();
    // Seed: one workflow run + one conversation run (the latter must be
    // deleted by the migration).
    db.query(
      `INSERT INTO run_state (run_id, version, status, kind, current_node, workflow_sha, schema_version,
         routing, metrics, priority, enqueued_at, ready_at, updated_at)
       VALUES (?, 1, 'queued', 'workflow', NULL, ?, 6, '{}', '{}', 0, 0, 0, 0)`,
    ).run("r-wf", "wf-1");
    db.query(
      `INSERT INTO run_state (run_id, version, status, kind, current_node, workflow_sha,
         parent_run_id, parent_node_id, parent_iteration,
         schema_version, routing, metrics, priority, enqueued_at, ready_at, updated_at)
       VALUES (?, 1, 'queued', 'conversation', NULL, NULL, ?, ?, ?, 6, '{}', '{}', 0, 0, 0, 0)`,
    ).run("r-conv", "r-wf", "plan", 0);

    migrate(db);

    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);

    const ids = db.query<{ run_id: string }, []>("SELECT run_id FROM run_state ORDER BY run_id").all();
    expect(ids.map((r) => r.run_id)).toEqual(["r-wf"]);

    // The kind column is gone — querying it errors.
    expect(() => db.query("SELECT kind FROM run_state").all()).toThrow(/no such column/i);
    // parent_* columns are gone too.
    expect(() => db.query("SELECT parent_run_id FROM run_state").all()).toThrow(/no such column/i);

    // workflow_sha is back to NOT NULL — verify by inserting NULL throws.
    expect(() =>
      db
        .query(
          `INSERT INTO run_state (run_id, version, status, current_node, workflow_sha, schema_version,
           routing, metrics, priority, enqueued_at, ready_at, updated_at)
         VALUES (?, 1, 'queued', NULL, NULL, 7, '{}', '{}', 0, 0, 0, 0)`,
        )
        .run("r-bad"),
    ).toThrow(/NOT NULL constraint failed: run_state.workflow_sha/);
    db.close();
  });

  test("v7 → v8 sweeps pre-existing orphan events / messages / artifacts so foreign_key_check passes", () => {
    // Reproduces the harness-boot failure: a v7 DB that already
    // carries orphan events / messages whose run_id no longer exists
    // in run_state (introduced by some prior cleanup that ran with
    // FKs off — manual surgery, crash recovery, an earlier migration
    // bug). v8's foreign_key_check would have surfaced them as
    // "v7 → v8 left FK violations" until the defensive vacuum landed.
    //
    // We pin straight to v7 (skipping the v6 → v7 step that doesn't
    // cascade-delete events) so the orphan setup is cleanly under
    // our control.
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version (id, version) VALUES (1, 7);
      CREATE TABLE workflows (sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      INSERT INTO workflows (sha, name, dot_source, created_at) VALUES ('wf-1', 't', 'digraph {}', 0);
      CREATE TABLE run_state (
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

      -- One real run + ghost events / messages / artifacts /
      -- legacy fact-type / orphan blob.
      INSERT INTO run_state (run_id, version, status, current_node, workflow_sha, schema_version,
        routing, metrics, priority, enqueued_at, ready_at, updated_at)
        VALUES ('r-real', 1, 'queued', NULL, 'wf-1', 7, '{}', '{}', 0, 0, 0, 0);
      INSERT INTO events (run_id, seq, type, writer, payload, ts)
        VALUES ('r-real',  1, 'fact.run_started', 'daemon', '{}', 0);
      INSERT INTO events (run_id, seq, type, writer, payload, ts)
        VALUES ('r-ghost', 1, 'fact.run_started', 'daemon', '{}', 0);
      INSERT INTO events (run_id, seq, type, writer, payload, ts)
        VALUES ('r-real',  2, 'fact.run_paused_retry', 'daemon', '{}', 0);
      INSERT INTO messages (run_id, ordinal, content) VALUES ('r-ghost', 0, '{"role":"user"}');
      INSERT INTO blobs (sha256, size_bytes, created_at) VALUES ('sha-orphan', 0, 0);
      INSERT INTO blobs (sha256, size_bytes, created_at) VALUES ('sha-keep', 0, 0);
      INSERT INTO artifacts (run_id, node_id, iteration, key, blob_sha, created_at)
        VALUES ('r-real', 'n', 0, 'k', 'sha-keep', 0);
    `);

    expect(() => migrate(db)).not.toThrow();

    // r-real survives, r-ghost rows vacuumed, fact.run_paused_retry retired.
    const events = db
      .query<{ run_id: string; type: string }, []>("SELECT run_id, type FROM events ORDER BY run_id, seq")
      .all();
    expect(events).toEqual([{ run_id: "r-real", type: "fact.run_started" }]);

    const messageCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get();
    expect(messageCount?.n).toBe(0);

    const blobs = db.query<{ sha256: string }, []>("SELECT sha256 FROM blobs ORDER BY sha256").all();
    expect(blobs.map((b) => b.sha256)).toEqual(["sha-keep"]);

    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});
