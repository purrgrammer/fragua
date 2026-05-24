/// <reference path="./globals.d.ts" />
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";
// Bun's bundler inlines the SQL into the JS output so `bun build --compile`
// embeds it in the binary. Reading via `readFileSync(import.meta.dir + "/schema.sql")`
// breaks in compiled mode — `/$bunfs/root/schema.sql` doesn't exist.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

/**
 * Create the schema on `db` and pin `schema_version`.
 *
 * 0.1.0 baseline: `schema.sql` is the only shape, so there is no
 * walk-forward chain. The first post-0.1.0 schema change reintroduces a
 * step-delta map keyed by target version and the walk that consumes it.
 *
 * - Fresh DB (no `schema_version` table): run `schema.sql`, pin to
 *   `CURRENT_SCHEMA_VERSION`.
 * - Existing DB at `version === CURRENT_SCHEMA_VERSION`: idempotent
 *   re-run of `schema.sql` to pick up any `IF NOT EXISTS` index/table.
 * - Existing DB at `version > CURRENT_SCHEMA_VERSION` or
 *   `< MIN_COMPATIBLE_SCHEMA_VERSION`: refuse — the store predates this
 *   baseline (or is a downgrade), and there is no migration path.
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

  // Already in the compatible band: re-run the bootstrap so any `IF NOT EXISTS`
  // index/table declared in `schema.sql` lands on the existing DB.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
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
