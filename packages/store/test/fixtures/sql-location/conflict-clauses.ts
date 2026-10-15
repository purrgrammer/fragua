// Fixture: DML/DQL forms the old SQL_RE missed, one literal per line.

import type { Database } from "bun:sqlite";

export function conflictClauses(db: Database, inner: string, tail: string): void {
  db.query(`UPDATE OR ABORT t SET a = 1`).run();
  db.query(`UPDATE OR REPLACE "t" SET a = 1`).run();
  db.query(`update or ignore main.t set a = 1`).run();
  db.query(`REPLACE INTO t (a) VALUES (1)`).run();
  db.query(`WITH picked AS (${inner}) ${tail}`).run();
  db.query(`WITH RECURSIVE n AS (${inner}) ${tail}`).run();
}
