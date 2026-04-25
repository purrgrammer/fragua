import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Apply the schema to `db` and pin the `schema_version` row. Pre-
 * release: no cross-version migrations across the schema_version
 * boundary — a version mismatch is schema drift and the daemon refuses
 * to start. Delete the DB to start clean.
 *
 * Additive changes that don't change the on-disk semantics for existing
 * rows are applied without bumping the version (see `applyAdditiveMigrations`).
 * This keeps long-paused HITL runs alive across deployments that only add
 * columns.
 */
export function migrate(db: Database): void {
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    applyAdditiveMigrations(db);
    const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
    if (row == null) {
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
      return;
    }
    if (row.version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `schema drift: db has version ${row.version}, code expects ${CURRENT_SCHEMA_VERSION}. ` +
          "Pre-release: delete .swarm/swarm.db and restart.",
      );
    }
  })();
}

function applyAdditiveMigrations(db: Database): void {
  // messages.content_hash + idx_messages_dedup landed without a version
  // bump because they're additive: pre-existing rows get a NULL hash
  // and the partial unique index ignores them. New writes always set
  // content_hash so dedup applies going forward.
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all();
  if (!cols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE messages ADD COLUMN content_hash TEXT");
  }
}
