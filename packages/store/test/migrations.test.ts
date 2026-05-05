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

describe("migrate — v4 → v5 conversation kind", () => {
  /** Build a minimal v4-shaped run_state table (pre-v5 column set) so we
   *  can exercise the v4→v5 step delta in isolation. The v5 migration
   *  rebuilds the table; we only need the columns the rebuild reads. */
  function seedV4Db(): Database {
    const db = freshDb();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version (id, version) VALUES (1, 4);
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
        total_cost_usd REAL GENERATED ALWAYS AS
          (CAST(COALESCE(json_extract(metrics, '$.totalCostUsd'), 0) AS REAL)) STORED,
        billed_tokens INTEGER GENERATED ALWAYS AS
          (CAST(COALESCE(json_extract(metrics, '$.billedTokens'), 0) AS INTEGER)) STORED
      ) STRICT;
    `);
    return db;
  }

  test("v4 → v5 walks; existing rows get kind='workflow', workflow_sha unchanged, parent columns NULL", () => {
    const db = seedV4Db();
    db.query(
      `INSERT INTO run_state (run_id, version, status, current_node, workflow_sha, schema_version,
         routing, metrics, priority, enqueued_at, ready_at, updated_at)
       VALUES (?, 1, 'queued', NULL, ?, 4, '{}', '{}', 0, 0, 0, 0)`,
    ).run("r-old-1", "wf-1");
    db.query(
      `INSERT INTO run_state (run_id, version, status, current_node, workflow_sha, schema_version,
         routing, metrics, priority, enqueued_at, ready_at, updated_at)
       VALUES (?, 2, 'running', 'n1', ?, 4, '{}', '{}', 0, 1, 1, 1)`,
    ).run("r-old-2", "wf-1");

    migrate(db);

    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);

    const rows = db
      .query<
        {
          run_id: string;
          kind: string;
          workflow_sha: string | null;
          parent_run_id: string | null;
          parent_node_id: string | null;
          parent_iteration: number | null;
        },
        []
      >(
        `SELECT run_id, kind, workflow_sha, parent_run_id, parent_node_id, parent_iteration
           FROM run_state ORDER BY run_id`,
      )
      .all();

    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.kind).toBe("workflow");
      expect(r.workflow_sha).toBe("wf-1");
      expect(r.parent_run_id).toBeNull();
      expect(r.parent_node_id).toBeNull();
      expect(r.parent_iteration).toBeNull();
    }
    db.close();
  });

  test("v5 partial parent index is used by EXPLAIN QUERY PLAN for WHERE parent_run_id=?", () => {
    const db = freshDb();
    migrate(db);
    const plan = db
      .query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN SELECT run_id FROM run_state WHERE parent_run_id = ?")
      .all("any");
    const text = plan.map((r) => r.detail).join("\n");
    expect(text).toContain("idx_run_state_parent");
    db.close();
  });
});
