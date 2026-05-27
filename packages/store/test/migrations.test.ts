// Migration policy — fresh DB bootstrap + walk-forward step deltas.
// `migrate()` creates `schema.sql` on a fresh DB, and walks an existing store
// forward through SCHEMA_MIGRATIONS up to CURRENT_SCHEMA_VERSION. See
// packages/store/src/migrations.ts + pragmas.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, verifySchema } from "../src/migrations.ts";
import { applyCreationPragmas, applyPragmas, CURRENT_SCHEMA_VERSION } from "../src/pragmas.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  applyCreationPragmas(db);
  applyPragmas(db);
  return db;
}

describe("migrate — schema version handling", () => {
  test("fresh DB: creates the baseline and stamps CURRENT_SCHEMA_VERSION", () => {
    const db = freshDb();
    migrate(db);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(row?.version).toBe(CURRENT_SCHEMA_VERSION);
    // Baseline tables exist.
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("run_state");
    expect(tables).toContain("events");
    expect(tables).toContain("workflows");
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

  test("above CURRENT (a pre-baseline store): throws downgrade-refused", () => {
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION + 100);
    expect(() => migrate(db)).toThrow(/downgrade refused/i);
    db.close();
  });

  test("v1 → v2 walk: renames schedules.input → title, preserving data", () => {
    const db = freshDb();
    migrate(db); // current shape (schedules.title)

    // Simulate a v1 store: rename the column back to `input`, seed a row with a
    // value under `input`, and pin the version to 1.
    db.query("ALTER TABLE schedules RENAME COLUMN title TO input").run();
    db.query(
      "INSERT INTO schedules (id, workflow_ref, cwd, project_id, interval_ms, interval_text, input, next_fire_at, created_at) " +
        "VALUES ('s1', 'wf', '/p', 'p', 3600000, '1h', 'nightly dep sweep', 0, 0)",
    ).run();
    db.query("UPDATE schema_version SET version = 1").run();

    migrate(db);

    // Version advanced to current.
    const ver = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    expect(ver?.version).toBe(CURRENT_SCHEMA_VERSION);

    // Column renamed: `title` present, `input` gone.
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(schedules)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("title");
    expect(cols).not.toContain("input");

    // The row's value survived the rename under the new column name.
    const row = db.query<{ title: string }, []>("SELECT title FROM schedules WHERE id = 's1'").get();
    expect(row?.title).toBe("nightly dep sweep");
    db.close();
  });
});

describe("verifySchema — read-the-version-and-refuse-to-bump", () => {
  function indexExists(db: Database, name: string): boolean {
    return db.query("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name) != null;
  }

  test("uninitialized DB (no schema_version): refuses, points at the harness", () => {
    const db = freshDb();
    expect(() => verifySchema(db)).toThrow(/uninitialized.*harness/i);
    db.close();
  });

  test("in-band version: does not throw and writes nothing", () => {
    const db = freshDb();
    migrate(db);
    // A schema.sql index that `migrate` re-creates via IF NOT EXISTS but
    // `verifySchema` must not touch.
    db.query("DROP INDEX idx_events_type").run();
    expect(indexExists(db, "idx_events_type")).toBe(false);

    verifySchema(db);
    expect(indexExists(db, "idx_events_type")).toBe(false); // verify left it dropped

    migrate(db);
    expect(indexExists(db, "idx_events_type")).toBe(true); // migrate re-created it
    db.close();
  });

  test("below MIN: throws schema-drift", () => {
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = 0").run();
    expect(() => verifySchema(db)).toThrow(/schema drift/i);
    db.close();
  });

  test("above CURRENT: throws downgrade-refused", () => {
    const db = freshDb();
    migrate(db);
    db.query("UPDATE schema_version SET version = ?").run(CURRENT_SCHEMA_VERSION + 100);
    expect(() => verifySchema(db)).toThrow(/downgrade refused/i);
    db.close();
  });
});
