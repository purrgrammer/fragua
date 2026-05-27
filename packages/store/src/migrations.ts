/// <reference path="./globals.d.ts" />
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";
// Bun's bundler inlines the SQL into the JS output so `bun build --compile`
// embeds it in the binary. Reading via `readFileSync(import.meta.dir + "/schema.sql")`
// breaks in compiled mode — `/$bunfs/root/schema.sql` doesn't exist.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

/** Walk-forward schema migrations, keyed by the TARGET version they produce.
 * Each step runs inside the bootstrap transaction, after the idempotent
 * `schema.sql` re-run, when an existing store is below that target. A fresh
 * DB skips these entirely — `schema.sql` already emits the current shape.
 *
 * `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table,
 * so a column rename MUST be an explicit `ALTER` here; the bootstrap re-run
 * alone never reshapes an existing table. */
const SCHEMA_MIGRATIONS: Record<number, (db: Database) => void> = {
  // v1 → v2: the run-input cleanup renamed the schedules description column.
  2: (db) => {
    db.exec("ALTER TABLE schedules RENAME COLUMN input TO title");
  },
};

/**
 * Create the schema on `db` and pin `schema_version`.
 *
 * - Fresh DB (no `schema_version` table): run `schema.sql` (current shape),
 *   pin to `CURRENT_SCHEMA_VERSION`. No migration steps run.
 * - Existing DB in `[MIN_COMPATIBLE, CURRENT]`: idempotent re-run of
 *   `schema.sql` (picks up any new `IF NOT EXISTS` index/table), then walk
 *   `SCHEMA_MIGRATIONS[version+1 … CURRENT]` to reshape existing tables, then
 *   pin the new version. A store already at `CURRENT` walks zero steps.
 * - Existing DB at `version > CURRENT_SCHEMA_VERSION` or
 *   `< MIN_COMPATIBLE_SCHEMA_VERSION`: refuse (downgrade / pre-baseline).
 */
export function migrate(db: Database): void {
  const version = readVersion(db);

  if (version == null) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    })();
    return;
  }

  checkVersion(version);
  if (version === CURRENT_SCHEMA_VERSION) {
    // Idempotent bootstrap re-run to land any new `IF NOT EXISTS` index/table.
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
    })();
    return;
  }

  // Walk forward: bootstrap (no-op on existing tables), apply each step delta
  // from the store's version up to current, then pin. One transaction so a
  // failed step rolls back the whole walk.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    for (let target = version + 1; target <= CURRENT_SCHEMA_VERSION; target++) {
      const step = SCHEMA_MIGRATIONS[target];
      if (step == null) throw new Error(`no schema migration registered for target version ${target}`);
      step(db);
    }
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION);
  })();
}

/**
 * Validate an existing store's `schema_version` without creating or mutating
 * anything — the open mode a store-client uses (`new SqliteStore({ migrate:
 * false })`). Refuses an uninitialized store (only the harness/daemon
 * bootstraps schema) and refuses any version outside the
 * `[MIN_COMPATIBLE, CURRENT]` compatible band.
 */
export function verifySchema(db: Database): void {
  const version = readVersion(db);
  if (version == null) {
    throw new Error("no fragua store here (schema uninitialized) — start the harness to create it");
  }
  checkVersion(version);
}

function readVersion(db: Database): number | null {
  const hasSchemaVersion =
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() != null;
  if (!hasSchemaVersion) return null;

  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
  if (row == null) {
    throw new Error("schema_version table exists but carries no row — DB is in an inconsistent state");
  }
  return row.version;
}

/** Refuse a version outside the `[MIN_COMPATIBLE, CURRENT]` compatible band —
 * shared by `migrate` and `verifySchema` so the two can't drift. */
function checkVersion(version: number): void {
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `schema downgrade refused: db has version ${version}, ` +
        `code expects ${CURRENT_SCHEMA_VERSION}. Re-deploy a newer daemon ` +
        "or start from a fresh store.",
    );
  }

  if (version < MIN_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(
      `schema drift: db has version ${version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
        "No migration registered from that version forward.",
    );
  }
}
