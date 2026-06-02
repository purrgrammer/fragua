/// <reference path="./globals.d.ts" />
import type { Database } from "bun:sqlite";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION } from "./pragmas.ts";
// Bun's bundler inlines the SQL into the JS output so `bun build --compile`
// embeds it in the binary. Reading via `readFileSync(import.meta.dir + "/schema.sql")`
// breaks in compiled mode — `/$bunfs/root/schema.sql` doesn't exist.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

/** A single versioned schema step. `up` reshapes a store from version `v-1`
 * to `v`; `down` (when present) reverses exactly that, reshaping `v` back to
 * `v-1`. A step with no `down` is irreversible — a downgrade walk refuses to
 * cross it (and must list it in `IRREVERSIBLE` with a reason, enforced by a
 * test). `lossy` marks a `down` that restores SHAPE but not DATA: it drops or
 * narrows a source-of-truth column/table whose values can't be rebuilt, so the
 * down walk refuses it without an explicit opt-in.
 *
 * Each `up` must be SELF-CONTAINED — it creates/alters everything its target
 * version adds, rather than leaning on the `schema.sql` re-run. The full
 * forward walk re-runs `schema.sql` (so additive `CREATE … IF NOT EXISTS`
 * objects land even without a step), but a forward-partial walk (`migrateTo`
 * to a version below CURRENT) does NOT — `schema.sql` only ever encodes the
 * CURRENT shape, so stopping short relies on the up-step deltas alone. */
export interface Migration {
  up: (db: Database) => void;
  down?: (db: Database) => void;
  lossy?: boolean;
}

/** Walk schema migrations, keyed by the TARGET version each `up` produces.
 * A fresh DB skips these entirely — `schema.sql` already emits the current
 * shape. An existing DB below CURRENT walks `up[version+1 … CURRENT]`.
 *
 * `schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table,
 * so a column rename MUST be an explicit `ALTER` here; the bootstrap re-run
 * alone never reshapes an existing table. */
const SCHEMA_MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: the run-input cleanup renamed the schedules description column.
  2: {
    up: (db) => db.exec("ALTER TABLE schedules RENAME COLUMN input TO title"),
    down: (db) => db.exec("ALTER TABLE schedules RENAME COLUMN title TO input"),
  },
};

/** Steps that deliberately ship without a `down`, each with the reason a
 * downgrade past it is unsupported. A step appears here XOR declares a `down`
 * — the coverage-discipline test fails if one is in neither (a forgotten
 * `down`) or both (contradiction). Empty today: every step round-trips. */
const IRREVERSIBLE: Record<number, string> = {};

/**
 * Create the schema on `db` and pin `schema_version`.
 *
 * - Fresh DB (no `schema_version` table): run `schema.sql` (current shape),
 *   pin to `CURRENT_SCHEMA_VERSION`. No migration steps run.
 * - Existing DB in `[MIN_COMPATIBLE, CURRENT]`: idempotent re-run of
 *   `schema.sql` (picks up any new `IF NOT EXISTS` index/table), then walk
 *   `SCHEMA_MIGRATIONS[version+1 … CURRENT]` to reshape existing tables, then
 *   pin the new version. A store already at `CURRENT` walks zero steps.
 * - Existing DB at `version > CURRENT_SCHEMA_VERSION` or
 *   `< MIN_COMPATIBLE_SCHEMA_VERSION`: refuse (downgrade / pre-baseline).
 */
export function migrate(db: Database): void {
  const version = readVersion(db);

  if (version == null) {
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      db.query("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    })();
    return;
  }

  checkVersion(version);
  if (version === CURRENT_SCHEMA_VERSION) {
    // Idempotent bootstrap re-run to land any new `IF NOT EXISTS` index/table.
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
    })();
    return;
  }

  // Walk forward: bootstrap (no-op on existing tables), apply each step delta
  // from the store's version up to current, then pin. One transaction so a
  // failed step rolls back the whole walk.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    for (const s of planMigration(version, CURRENT_SCHEMA_VERSION).steps) {
      const step = SCHEMA_MIGRATIONS[s.version];
      if (step == null) throw new Error(`no schema migration registered for target version ${s.version}`);
      step.up(db);
    }
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(CURRENT_SCHEMA_VERSION);
  })();
}

/** One entry in a `migrateTo` plan — a step to run and its reversibility class
 * (the class matters only on the down walk, but `migrateTo --dry-run` prints it
 * for both directions so the operator sees what each step is). */
export interface MigrationPlanStep {
  /** The version this step moves THROUGH. Forward: the target `up` produces.
   * Down: the version whose `down` we run (it lands on `version-1`). */
  version: number;
  class: "full" | "lossy" | "irreversible";
  /** Set only for `irreversible` — the reason from `IRREVERSIBLE`. */
  reason?: string;
}

export interface MigrationPlan {
  from: number;
  to: number;
  direction: "up" | "down" | "none";
  steps: MigrationPlanStep[];
}

/** Pure, side-effect-free: compute the ordered step plan for `from → to`
 * without touching a DB. Throws on an out-of-band target so the caller surfaces
 * one consistent message for `--dry-run` and the real walk. Down steps are
 * listed in descending order (the order they run). */
export function planMigration(from: number, to: number): MigrationPlan {
  if (to > CURRENT_SCHEMA_VERSION) {
    throw new Error(`cannot migrate to v${to}: this binary only knows up to v${CURRENT_SCHEMA_VERSION}`);
  }
  if (to < MIN_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(`cannot migrate to v${to}: below the supported floor v${MIN_COMPATIBLE_SCHEMA_VERSION}`);
  }
  if (from > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `store is v${from}, newer than this binary (v${CURRENT_SCHEMA_VERSION}) — ` +
        "a downgrade must be run by the newer binary that defines the down steps",
    );
  }
  if (to === from) return { from, to, direction: "none", steps: [] };

  const steps: MigrationPlanStep[] = [];
  if (to > from) {
    for (let v = from + 1; v <= to; v++) steps.push({ version: v, class: classOf(v) });
    return { from, to, direction: "up", steps };
  }
  for (let v = from; v > to; v--) {
    const cls = classOf(v);
    const reason = IRREVERSIBLE[v];
    steps.push(
      cls === "irreversible" && reason != null ? { version: v, class: cls, reason } : { version: v, class: cls },
    );
  }
  return { from, to, direction: "down", steps };
}

function classOf(version: number): "full" | "lossy" | "irreversible" {
  const step = SCHEMA_MIGRATIONS[version];
  if (step?.down == null) return "irreversible";
  return step.lossy ? "lossy" : "full";
}

/**
 * Walk a store's schema from its current version to an explicit `target`,
 * UP or DOWN. This is the engine behind `fragua db migrate --to`; the
 * automatic open paths (`migrate`, `verifySchema`) never call it.
 *
 * - **up** (`target > current`): re-run `schema.sql` ONLY for a full walk to
 *   CURRENT (lands additive `IF NOT EXISTS` objects); a partial forward relies
 *   on the self-contained `up` deltas. Apply `up[current+1 … target]`, pin.
 * - **down** (`target < current`): apply `down[current], down[current-1], …,
 *   down[target+1]` in descending order, pin. NEVER re-runs `schema.sql` —
 *   that would recreate the very objects a `down` just dropped.
 * - **none** (`target === current`): no-op.
 *
 * Reversibility and loss are checked BEFORE any mutation (out of the
 * transaction). The first irreversible step in range refuses the whole walk;
 * a `lossy` step refuses unless `allowDataLoss`. The walk + version pin run in
 * one transaction so a failing step rolls the whole thing back.
 */
export function migrateTo(db: Database, target: number, opts: { allowDataLoss?: boolean } = {}): MigrationPlan {
  const current = readVersion(db);
  if (current == null) {
    throw new Error("no fragua store here (schema uninitialized) — start the harness to create it");
  }
  const plan = planMigration(current, target);
  if (plan.direction === "none") return plan;

  if (plan.direction === "down") {
    const irreversible = plan.steps.find((s) => s.class === "irreversible");
    if (irreversible) {
      throw new Error(
        `cannot downgrade past v${irreversible.version}: ${irreversible.reason ?? "migration declares no `down`"}`,
      );
    }
    const lossy = plan.steps.filter((s) => s.class === "lossy");
    if (lossy.length > 0 && !opts.allowDataLoss) {
      const vs = lossy.map((s) => `v${s.version}`).join(", ");
      throw new Error(`downgrade loses data at ${vs} — re-run with --allow-data-loss to proceed`);
    }
  }

  db.transaction(() => {
    // `current` was read (and the plan validated) before the transaction. Under
    // WAL the body runs on a read snapshot, but another writer (e.g. a second
    // `db migrate` — the CLI liveness gate only guards against a daemon) could
    // have advanced `schema_version` in the gap. Re-read inside the transaction
    // and refuse if it moved, so the walk never applies against a state
    // `planMigration` didn't validate.
    const live = readVersion(db);
    if (live !== current) {
      throw new Error(`schema_version moved under the migrate (planned from v${current}, store now v${live}) — re-run`);
    }
    if (plan.direction === "up") {
      if (target === CURRENT_SCHEMA_VERSION) db.exec(SCHEMA_SQL);
      for (const s of plan.steps) {
        const step = SCHEMA_MIGRATIONS[s.version];
        if (step == null) throw new Error(`no schema migration registered for target version ${s.version}`);
        step.up(db);
      }
    } else {
      for (const s of plan.steps) {
        const down = SCHEMA_MIGRATIONS[s.version]?.down;
        if (down == null) throw new Error(`no down step for v${s.version}`);
        down(db);
      }
    }
    db.query("UPDATE schema_version SET version = ? WHERE id = 1").run(target);
  })();
  return plan;
}

/** Test-facing view of the registered steps — lets the coverage-discipline
 * test assert every step is reversible XOR explicitly irreversible without
 * exporting the mutable maps. */
export function migrationRegistry(): { versions: number[]; reversible: number[]; irreversible: number[] } {
  const versions = Object.keys(SCHEMA_MIGRATIONS).map(Number);
  return {
    versions,
    reversible: versions.filter((v) => SCHEMA_MIGRATIONS[v]?.down != null),
    irreversible: Object.keys(IRREVERSIBLE).map(Number),
  };
}

/**
 * Validate an existing store's `schema_version` without creating or mutating
 * anything — the open mode a store-client uses (`new SqliteStore({ migrate:
 * false })`). Refuses an uninitialized store (only the harness/daemon
 * bootstraps schema) and refuses any version outside the
 * `[MIN_COMPATIBLE, CURRENT]` compatible band.
 */
export function verifySchema(db: Database): void {
  const version = readVersion(db);
  if (version == null) {
    throw new Error("no fragua store here (schema uninitialized) — start the harness to create it");
  }
  checkVersion(version);
}

function readVersion(db: Database): number | null {
  const hasSchemaVersion =
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() != null;
  if (!hasSchemaVersion) return null;

  const row = db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get();
  if (row == null) {
    throw new Error("schema_version table exists but carries no row — DB is in an inconsistent state");
  }
  return row.version;
}

/** Refuse a version outside the `[MIN_COMPATIBLE, CURRENT]` compatible band —
 * shared by `migrate` and `verifySchema` so the two can't drift. */
function checkVersion(version: number): void {
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `schema downgrade refused: db has version ${version}, ` +
        `code expects ${CURRENT_SCHEMA_VERSION}. Re-deploy a newer daemon ` +
        "or start from a fresh store.",
    );
  }

  if (version < MIN_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error(
      `schema drift: db has version ${version}, code requires ≥ ${MIN_COMPATIBLE_SCHEMA_VERSION}. ` +
        "No migration registered from that version forward.",
    );
  }
}
