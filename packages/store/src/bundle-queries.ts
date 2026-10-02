import type { Database } from "bun:sqlite";

/** Every user table name (excludes SQLite's internal `sqlite_*` tables). The
 * `retainPortableTables` prune reads this to decide which tables to drop. */
export function selectUserTableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
}
