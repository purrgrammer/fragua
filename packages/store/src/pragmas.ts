import type { Database } from "bun:sqlite";

/** Schema version this code emits for new DBs — the DB-migration counter.
 * v2 renames `schedules.input` → `schedules.title` (the run-input cleanup
 * that drops free-form `routing.input`); the walk-forward step lives in
 * `migrations.ts` (SCHEMA_MIGRATIONS). Note: it does NOT gate run resume —
 * runs pin `EVENT_CONTRACT_VERSION` for that (axis split, §3.1). */
export const CURRENT_SCHEMA_VERSION = 2;

/** Lowest schema version `migrate()` accepts and walks forward from. A v1
 * store (the 0.1.0 baseline) migrates to current; nothing older exists. */
export const MIN_COMPATIBLE_SCHEMA_VERSION = 1;

/** Event-contract version a run pins at enqueue, and the executor's
 * run-resume gate. DISTINCT from `CURRENT_SCHEMA_VERSION` (the DB-migration
 * counter): it bumps ONLY when `FactEvent`/`IntentEvent` payload shapes or
 * reducer fold-semantics actually change — a rare event — so the resume gate
 * stops tripping on projection-only migrations. See
 * docs/proposals/archive/event-contract-version.md §3.1. The contract-surface hash
 * test (packages/store/test/contract-version.test.ts) forces a conscious
 * bump-or-resnapshot whenever the surface moves. */
export const EVENT_CONTRACT_VERSION = 1;

/** Lowest contract version the daemon folds. Ratchets ONLY by deliberate act
 * (§3.4): advancing it strands every run pinned below it, so it moves only in
 * a dedicated commit that names the dropped versions and removes their reducer
 * paths. A snapshot test pins this value. */
export const MIN_COMPATIBLE_CONTRACT_VERSION = 1;

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
