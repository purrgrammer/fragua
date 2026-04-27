import type { Database } from "bun:sqlite";

/** Schema version this code emits for new DBs and pins on new runs. */
export const CURRENT_SCHEMA_VERSION = 5;

/**
 * Lowest schema version this daemon can resume.
 *
 * Bumping policy:
 *   - **Additive change** (new column with safe default, new event type
 *     consumers ignore, new optional payload field): bump
 *     `CURRENT_SCHEMA_VERSION` only. Old runs pinned at versions ≥ MIN
 *     keep resuming. Add an entry to `applyAdditiveMigrations` if the
 *     change touches existing tables; brand-new tables go in `schema.sql`
 *     under `CREATE TABLE IF NOT EXISTS`.
 *   - **Breaking change** (column removed/renamed, semantics flipped,
 *     event type retired): bump BOTH constants together. Existing runs
 *     pinned below the new MIN halt with `fact.run_halted { reason:
 *     "schema_drift" }` on the next dispatch boundary. The DB-level
 *     migration also throws so a daemon can't accidentally start against
 *     an older snapshot.
 *
 * The two-constant range deliberately favours operational continuity for
 * an interactive tool — long-paused HITL runs survive any deploy that
 * only adds new attributes / events.
 */
export const MIN_COMPATIBLE_SCHEMA_VERSION = 3;

/**
 * Apply connection-level pragmas. Called on every opened Database.
 *
 * `page_size` is only effective before the database file is populated, so
 * callers must set it via `applyCreationPragmas` on a fresh file.
 */
export function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

/**
 * Apply creation-only pragmas. Must run before any CREATE TABLE on a brand-new DB.
 */
export function applyCreationPragmas(db: Database): void {
  db.exec("PRAGMA page_size = 8192");
}
