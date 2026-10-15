// Fixture (R2-M2): a SELECT with no whitespace after the keyword.

import type { Database } from "bun:sqlite";

export function noSpaceSelect(db: Database): unknown[] {
  return db.query("SELECT*FROM run_state").all();
}
