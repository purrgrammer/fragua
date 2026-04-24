import type { Database } from "bun:sqlite";

export const CURRENT_SCHEMA_VERSION = 3;

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
