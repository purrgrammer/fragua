// Fixture (R2-M2): a SELECT split across a `+` concatenation of literals.

import type { Database } from "bun:sqlite";

export function concatSelect(db: Database): unknown[] {
  return db.query("SEL" + "ECT * FROM run_state").all();
}
