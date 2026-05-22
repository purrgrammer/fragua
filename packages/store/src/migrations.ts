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
  const hasSchemaVersion =
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() != null;

  if (!hasSchemaVersion) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    })();
    return;
  }

  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
  if (row == null) {
    throw new Error("schema_version table exists but carries no row — DB is in an inconsistent state");
  }

  if (row.version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `schema downgrade refused: db has version ${row.version}, ` +
        `code expects ${CURRENT_SCHEMA_VERSION}. Re-deploy a newer daemon ` +
        "or start from a fresh store.",
    );
  }

  if (row.version < MIN_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(
      `schema drift: db has version ${row.version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
        "No migration registered from that version forward.",
    );
  }

  // Already at baseline: re-run the bootstrap so any `IF NOT EXISTS`
  // index/table declared in `schema.sql` lands on the existing DB.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
  })();
}
