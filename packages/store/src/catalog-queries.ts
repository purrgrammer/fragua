// SQL for reading the schema catalogue itself.

import type { Database } from "bun:sqlite";

const TABLE_EXISTS_SQL = `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`;

/** Whether `name` exists as a table. A store pruned to its portable tables
 * (`retainPortableTables`) has no credential tables at all, and the readers
 * that feed the export scrubber treat that as "no rows", not an error. */
export function tableExists(db: Database, name: string): boolean {
  return db.query<{ present: number }, [string]>(TABLE_EXISTS_SQL).get(name) !== null;
}
