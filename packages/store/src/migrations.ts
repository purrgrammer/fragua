import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(HERE, "schema.sql"), "utf8");

/**
 * Apply the schema to `db` and pin the `schema_version` row. Versions in
 * `[MIN_COMPATIBLE_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION]` are accepted —
 * additive migrations run idempotently and the row is bumped to CURRENT.
 * Versions below MIN throw schema-drift; versions above CURRENT throw
 * downgrade-refused. See `pragmas.ts` for the bumping policy.
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
    if (row.version !== CURRENT_SCHEMA_VERSION) {
      // Additive bump: row was at v=N, code is at v=M (N < M, both within
      // compat range). The additive migrations above already brought the
      // schema forward; record the new version.
      db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION);
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
