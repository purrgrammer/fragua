import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Apply the schema to `db` and pin the `schema_version` row. Pre-release:
 * `MIN_COMPATIBLE_SCHEMA_VERSION === CURRENT_SCHEMA_VERSION`, so any DB
 * pinned to a different version is rejected (`schema drift` for older,
 * `downgrade refused` for newer). Fresh DB only — delete `.swarm/swarm.db`
 * to recover.
 */
export function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    if (row == null) {
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
      return;
    }
    if (row.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `schema downgrade refused: db has version ${row.version}, code expects ≤ ${CURRENT_SCHEMA_VERSION}. ` +
          "Re-deploy a newer daemon or restore an older DB snapshot.",
      );
    }
    if (row.version < MIN_COMPATIBLE_SCHEMA_VERSION) {
      throw new Error(
        `schema drift: db has version ${row.version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
          "Pre-release: delete .swarm/swarm.db and restart.",
      );
    }
  })();
}
