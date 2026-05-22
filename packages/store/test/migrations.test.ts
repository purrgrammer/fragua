// Migration policy — 0.1.0 baseline, fresh DB only.
// `migrate()` creates `schema.sql` and pins `schema_version` to the
// baseline; there is no walk-forward chain yet. See
// packages/store/src/migrations.ts + pragmas.ts.

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
});
