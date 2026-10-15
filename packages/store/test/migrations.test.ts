// Migration policy — fresh DB bootstrap + walk-forward step deltas.
// `migrate()` creates `schema.sql` on a fresh DB, and walks an existing store
// forward through SCHEMA_MIGRATIONS up to CURRENT_SCHEMA_VERSION. See
// packages/store/src/migrations.ts + pragmas.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, migrateTo, planMigration, verifySchema } from "../src/migrations.ts";
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

describe("v7 ↔ v8 — run_state.claim_epoch", () => {
  const cols = (db: Database) =>
    db
      .query<{ name: string }, []>("PRAGMA table_info(run_state)")
      .all()
      .map((c) => c.name);

  test("v7→v8 adds run_state.claim_epoch and down drops it", () => {
    const db = freshDb();
    migrate(db);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(cols(db)).toContain("claim_epoch");
    expect(planMigration(8, 7).steps).toEqual([{ version: 8, class: "full" }]);
    migrateTo(db, 7);
    expect(cols(db)).not.toContain("claim_epoch");
    migrate(db);
    expect(cols(db)).toContain("claim_epoch");
    db.close();
  });
});

describe("v8 ↔ v9 — daemon_lock.harness_pid + server_endpoint.hostname", () => {
  const cols = (db: Database, table: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);

  test("v8→v9 adds harness_pid and server hostname; down drops them without data loss", () => {
    const db = freshDb();
    migrate(db);
    expect(CURRENT_SCHEMA_VERSION).toBe(9);
    expect(cols(db, "daemon_lock")).toContain("harness_pid");
    expect(cols(db, "server_endpoint")).toContain("hostname");
    expect(planMigration(9, 8).steps).toEqual([{ version: 9, class: "full" }]);

    db.query(
      "INSERT INTO daemon_lock (id, pid, hostname, started_at, heartbeat_at, harness_pid) VALUES (1, 41, 'h', 10, 20, 7)",
    ).run();
    db.query(
      "INSERT INTO server_endpoint (id, url, port, pid, started_at, harness_version, hostname) VALUES (1, 'u', 1, 7, 10, 'v', 'h')",
    ).run();

    migrateTo(db, 8);
    expect(cols(db, "daemon_lock")).not.toContain("harness_pid");
    expect(cols(db, "server_endpoint")).not.toContain("hostname");

    migrate(db);
    expect(cols(db, "daemon_lock")).toContain("harness_pid");
    expect(cols(db, "server_endpoint")).toContain("hostname");
    const lock = db
      .query<{ pid: number; hostname: string; heartbeat_at: number; harness_pid: number | null }, []>(
        "SELECT pid, hostname, heartbeat_at, harness_pid FROM daemon_lock WHERE id = 1",
      )
      .get();
    expect(lock).toEqual({ pid: 41, hostname: "h", heartbeat_at: 20, harness_pid: null });
    const endpoint = db
      .query<{ url: string; pid: number }, []>("SELECT url, pid FROM server_endpoint WHERE id = 1")
      .get();
    expect(endpoint).toEqual({ url: "u", pid: 7 });
    db.close();
  });
});

describe("v6 ↔ v7 — checkout columns", () => {
  const cols = (db: Database) =>
    db
      .query<{ name: string }, []>("PRAGMA table_info(run_state)")
      .all()
      .map((c) => c.name);
  const hasIndex = (db: Database) =>
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_run_state_checkout'").get() != null;

  test("v6 → v7 adds in_checkout, checkout_path, checkout_released and idx_run_state_checkout; down drops them (lossy)", () => {
    const db = freshDb();
    migrate(db);
    for (const c of ["in_checkout", "checkout_path", "checkout_released"]) expect(cols(db)).toContain(c);
    expect(hasIndex(db)).toBe(true);
    migrateTo(db, 7);
    expect(planMigration(7, 6).steps).toEqual([{ version: 7, class: "lossy" }]);
    expect(() => migrateTo(db, 6)).toThrow();
    migrateTo(db, 6, { allowDataLoss: true });
    for (const c of ["in_checkout", "checkout_path", "checkout_released"]) expect(cols(db)).not.toContain(c);
    expect(hasIndex(db)).toBe(false);
    // walking forward from v6 re-runs schema.sql first, which must not need the columns
    migrate(db);
    for (const c of ["in_checkout", "checkout_path", "checkout_released"]) expect(cols(db)).toContain(c);
    expect(hasIndex(db)).toBe(true);
    db.close();
  });
});

describe("v5 ↔ v6 — run_state.base_head_sha", () => {
  const cols = (db: Database) =>
    db
      .query<{ name: string }, []>("PRAGMA table_info(run_state)")
      .all()
      .map((c) => c.name);

  test("v5 → v6 adds run_state.base_head_sha; down drops it (lossy)", () => {
    const db = freshDb();
    migrate(db);
    expect(cols(db)).toContain("base_head_sha");
    expect(planMigration(6, 5).steps).toEqual([{ version: 6, class: "lossy" }]);
    expect(() => migrateTo(db, 5)).toThrow();
    migrateTo(db, 5, { allowDataLoss: true });
    expect(cols(db)).not.toContain("base_head_sha");
    migrate(db);
    expect(cols(db)).toContain("base_head_sha");
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
