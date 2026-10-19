// Fixture (R3-M4): UPDATE with a table alias, one statement per line.

import type { Database } from "bun:sqlite";

export function updateAlias(db: Database): void {
  db.query("UPDATE run_state AS r SET status = 'queued' WHERE r.run_id = ?").run("x");
  db.query("update or ignore main.run_state as r set version = 1").run();
  db.query(`UPDATE "run_state" AS "r" SET version = 1`).run();
  db.query("UPD" + "ATE run_state AS r SET a = 1").run();
}
