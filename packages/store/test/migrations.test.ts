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
    const db = freshDb();
    migrate(db);
    // Simulate a deploy that landed an additive bump: rewrite the row to
    // MIN, then re-run migrate. Only meaningful when CURRENT > MIN; if
    // they're equal this collapses to "no-op" (already covered above).
    if (MIN_COMPATIBLE_SCHEMA_VERSION === CURRENT_SCHEMA_VERSION) {
      // Fixture not exercisable until the first additive bump lands.
      // The path is still tested via the executor test — keeping this
      // assertion live so the day MIN <ed> CURRENT diverge, the test fires.
      expect(MIN_COMPATIBLE_SCHEMA_VERSION).toBe(CURRENT_SCHEMA_VERSION);
      db.close();
      return;
    }
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
