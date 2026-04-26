// Migration policy — additive vs breaking schema changes.
// See packages/store/src/pragmas.ts for the bumping policy.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrations.ts";
import {
  applyCreationPragmas,
  applyPragmas,
  CURRENT_SCHEMA_VERSION,
  MIN_COMPATIBLE_SCHEMA_VERSION,
} from "../src/pragmas.ts";

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

  test("idempotent: re-running migrate on a current DB is a no-op", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("additive bump: a DB at version MIN with CURRENT > MIN advances to CURRENT", () => {
    expect(MIN_COMPATIBLE_SCHEMA_VERSION).toBeLessThan(CURRENT_SCHEMA_VERSION);
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(MIN_COMPATIBLE_SCHEMA_VERSION);
    migrate(db);
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

describe("migrate — v3 → v4 run_state CHECK widening", () => {
  /** Build a v3-style schema by hand: run_state.status CHECK lacks
   * 'paused_provider_error'. The fixture lets us prove that:
   *   - migrate rebuilds the table without losing rows
   *   - the new status literal is accepted post-migration
   *   - the rebuild is idempotent on re-run
   * Generated columns + indexes are recreated as the migration claims.
   */
  function v3SchemaDb(): Database {
    const db = freshDb();
    // The rebuild flips foreign_keys OFF/ON around DROP TABLE.
    // Reproduce the production setting here so the test exercises the
    // same code path.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version (id, version) VALUES (1, 3);
      CREATE TABLE workflows (sha TEXT PRIMARY KEY, name TEXT NOT NULL, dot_source TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE run_state (
        run_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'queued','running','paused_hitl','completed','cancelled','halted','quarantined'
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
      CREATE INDEX idx_run_state_queue ON run_state(priority DESC, ready_at ASC) WHERE status = 'queued';
      CREATE INDEX idx_run_state_status ON run_state(status);
      CREATE INDEX idx_run_state_workflow ON run_state(workflow_sha);
      CREATE INDEX idx_run_state_updated ON run_state(updated_at);

      -- Tables that reference run_state with ON DELETE CASCADE. The
      -- rebuild's DROP TABLE on run_state must NOT cascade through these
      -- — without foreign_keys=OFF around the rebuild, the cascade fires
      -- and silently empties every event log and transcript on disk.
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
        content TEXT NOT NULL CHECK (json_valid(content) AND length(content) < 1048576),
        role TEXT GENERATED ALWAYS AS (json_extract(content, '$.role')) STORED,
        node_id TEXT,
        iteration INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, ordinal)
      ) STRICT, WITHOUT ROWID;

      INSERT INTO workflows (sha, name, dot_source, created_at) VALUES ('w1', 'demo', 'digraph G {}', 1);
      INSERT INTO run_state (run_id, version, status, current_node, workflow_sha, schema_version, routing, metrics, enqueued_at, ready_at, updated_at)
        VALUES ('r1', 1, 'paused_hitl', 'n1', 'w1', 3, '{}', '{"totalTokens":42,"totalCostUsd":0.5}', 1, 1, 1);
      INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES
        ('r1', 1, 'fact.run_started',  'daemon', '{}', 100),
        ('r1', 2, 'fact.node_started', 'daemon', '{}', 200),
        ('r1', 3, 'fact.node_completed','daemon','{}', 300);
      INSERT INTO messages (run_id, ordinal, content, node_id, iteration) VALUES
        ('r1', 1, '{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}', 'n1', 0),
        ('r1', 2, '{"role":"assistant","content":[{"type":"text","text":"ok"}],"timestamp":2}', 'n1', 0);
    `);
    return db;
  }

  test("rebuilds run_state, preserves existing rows + generated columns", () => {
    const db = v3SchemaDb();
    migrate(db);
    const ddl = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_state'")
      .get();
    expect(ddl?.sql).toContain("'paused_provider_error'");
    const row = db
      .query<
        {
          run_id: string;
          status: string;
          schema_version: number;
          total_cost_usd: number;
          total_tokens: number;
        },
        []
      >("SELECT run_id, status, schema_version, total_cost_usd, total_tokens FROM run_state WHERE run_id = 'r1'")
      .get();
    expect(row?.run_id).toBe("r1");
    expect(row?.status).toBe("paused_hitl");
    expect(row?.schema_version).toBe(3);
    expect(row?.total_cost_usd).toBeCloseTo(0.5);
    expect(row?.total_tokens).toBe(42);
    db.close();
  });

  test("REGRESSION: events + messages with ON DELETE CASCADE FKs survive the rebuild", () => {
    // The first cut of v3→v4 dropped run_state inside an open
    // transaction with foreign_keys=ON. SQLite cascades child deletes on
    // DROP TABLE in that mode, silently emptying events + messages +
    // artifacts. The fix toggles foreign_keys OFF/ON outside the txn;
    // this test asserts a populated child table stays populated.
    const db = v3SchemaDb();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(3);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(2);

    migrate(db);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n).toBe(3);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages").get()?.n).toBe(2);
    // FK still resolves: events.run_id points at the new run_state.
    const orphans = db.query<{ table: string }, []>("PRAGMA foreign_key_check").all();
    expect(orphans).toEqual([]);
    // foreign_keys was restored after the rebuild.
    const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
    expect(fk?.foreign_keys).toBe(1);
    db.close();
  });

  test("post-rebuild, the new status is insertable", () => {
    const db = v3SchemaDb();
    migrate(db);
    db.query(
      `INSERT INTO run_state (run_id, version, status, workflow_sha, schema_version, routing, metrics, enqueued_at, ready_at, updated_at)
         VALUES ('r2', 1, 'paused_provider_error', 'w1', 4, '{}', '{}', 1, 1, 1)`,
    ).run();
    const row = db.query<{ status: string }, []>("SELECT status FROM run_state WHERE run_id = 'r2'").get();
    expect(row?.status).toBe("paused_provider_error");
    db.close();
  });

  test("rebuild is idempotent on re-run", () => {
    const db = v3SchemaDb();
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const row = db.query<{ run_id: string }, []>("SELECT run_id FROM run_state WHERE run_id = 'r1'").get();
    expect(row?.run_id).toBe("r1");
    db.close();
  });

  test("schema_version row advances from 3 to CURRENT", () => {
    const db = v3SchemaDb();
    migrate(db);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("indexes survive the rebuild", () => {
    const db = v3SchemaDb();
    migrate(db);
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_state' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(idx).toEqual([
      "idx_run_state_queue",
      "idx_run_state_status",
      "idx_run_state_updated",
      "idx_run_state_workflow",
    ]);
    db.close();
  });
});
