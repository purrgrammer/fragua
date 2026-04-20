import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Apply the schema to `db` if not already present, and pin the schema_version
 * row. Idempotent across restarts.
 */
export function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    if (row == null) {
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
      return;
    }
    let version = row.version;
    while (version < CURRENT_SCHEMA_VERSION) {
      version = stepMigration(db, version);
    }
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`schema drift: db has version ${row.version}, code expects ${CURRENT_SCHEMA_VERSION}`);
    }
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(version);
  })();
}

function stepMigration(db: Database, from: number): number {
  switch (from) {
    case 1: {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(run_state)").all();
      if (!cols.some((c) => c.name === "title")) {
        db.exec("ALTER TABLE run_state ADD COLUMN title TEXT");
      }
      return 2;
    }
    case 2: {
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
      if (!cols.some((c) => c.name === "payload_json")) {
        db.exec("ALTER TABLE messages ADD COLUMN payload_json TEXT");
      }
      return 3;
    }
    default:
      throw new Error(`no migration registered from schema version ${from}`);
  }
}
