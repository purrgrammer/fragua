// `fragua db <action>` — DB maintenance.
//   vacuum    — reclaim free pages (VACUUM).
//   gc-blobs  — delete orphaned rows in the `blobs` table (no artifact refs).
//   backup    — SQLite online backup API into a target path.
//   migrate   — explicit, consent-driven schema migration (--dry-run prints
//               the plan). Store-client verbs open WITHOUT migrating and point
//               the operator here on a version mismatch; the harness/daemon
//               auto-migrate under their lock. Migrations are transactional +
//               version-gated, so this is gated on surprise, not correctness.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getFraguaHome } from "@fragua/agent";
import { CURRENT_SCHEMA_VERSION, DAEMON_LOCK_TTL_MS, migrateTo, planMigration, SqliteStore } from "@fragua/store";
import chalk from "chalk";

export interface DbCommandOptions {
  action: "vacuum" | "gc-blobs" | "backup" | "migrate";
  cwd?: string;
  /** Explicit store path. Overrides the default home store
   * (`$FRAGUA_HOME/fragua.db`, i.e. `~/.fragua/fragua.db`) — the same store the
   * harness binds and the `run`/`runs` verbs open. Point it at a project or
   * throwaway store to operate elsewhere. */
  dbPath?: string;
  /** For `backup` — destination path. For `migrate` — target schema version
   * (parsed as an integer); omitted ⇒ migrate forward to CURRENT. */
  to?: string;
  /** For `gc-blobs` — max rows to remove in one pass. */
  limit?: number;
  /** For `migrate` — print the plan without applying. */
  dryRun?: boolean;
  /** For `migrate` — allow a down step that restores shape but not data. */
  allowDataLoss?: boolean;
  /** For `migrate` — skip the pre-migrate backup (ephemeral / CI stores). */
  noBackup?: boolean;
}

export async function dbCommand(opts: DbCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(getFraguaHome(), "fragua.db");
  if (!existsSync(storePath)) {
    console.error(chalk.red(`db ${opts.action}: no store at ${storePath}`));
    return 1;
  }

  switch (opts.action) {
    case "vacuum": {
      const store = new SqliteStore({ path: storePath });
      store.vacuum();
      store.close();
      console.log(chalk.green(`vacuumed ${storePath}`));
      return 0;
    }
    case "gc-blobs": {
      const store = new SqliteStore({ path: storePath });
      const { deleted } = store.gcBlobs(opts.limit ?? 1000);
      store.close();
      console.log(chalk.green(`deleted ${deleted} orphan blob row(s)`));
      return 0;
    }
    case "backup": {
      if (opts.to == null || opts.to.length === 0) {
        console.error(chalk.red("db backup: --to <path> required"));
        return 1;
      }
      const dest = resolve(cwd, opts.to);
      serializeTo(storePath, dest);
      console.log(chalk.green(`backed up to ${dest}`));
      return 0;
    }
    case "migrate":
      return migrateDb(storePath, opts);
  }
}

/** Online copy of `storePath` → `dest` via `serialize()` + writeFile rather
 * than `VACUUM INTO`: the target's schema is replayed without the STORED
 * generated columns, so VACUUM INTO trips a column-count mismatch. */
function serializeTo(storePath: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  const src = new Database(storePath, { readonly: true });
  try {
    writeFileSync(dest, src.serialize());
  } finally {
    src.close();
  }
}

/** `<storePath dir>/backups/pre-migrate-v{from}-to-v{to}-<ts>.db`. Lives beside
 * the store being migrated, so a `--db` project store backs up next to itself
 * rather than into the global `~/.fragua`. */
function backupPath(storePath: string, from: number, to: number, ts: number): string {
  return join(dirname(storePath), "backups", `pre-migrate-v${from}-to-v${to}-${ts}.db`);
}

function migrateDb(storePath: string, opts: DbCommandOptions): number {
  // Read the current version + daemon liveness WITHOUT mutating. The
  // store-client open mode (`migrate:false`) throws on an out-of-band version —
  // exactly the case `db migrate` exists to resolve — so probe the raw rows.
  const probe = new Database(storePath, { readonly: true });
  let current: number | null;
  let heartbeatAt: number | null = null;
  try {
    const hasVersion = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    current = hasVersion
      ? (probe.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get()?.version ?? null)
      : null;
    const hasLock = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get();
    if (hasLock) {
      heartbeatAt =
        probe.query<{ heartbeat_at: number }, []>("SELECT heartbeat_at FROM daemon_lock WHERE id = 1").get()
          ?.heartbeat_at ?? null;
    }
  } finally {
    probe.close();
  }

  if (current === null) {
    console.error(chalk.red("db migrate: store is uninitialized (no schema_version) — start the harness to create it"));
    return 1;
  }

  const target = opts.to !== undefined ? Number(opts.to) : CURRENT_SCHEMA_VERSION;
  if (!Number.isInteger(target)) {
    console.error(chalk.red(`db migrate: --to expects an integer schema version, got "${opts.to}"`));
    return 1;
  }

  // planMigration carries the canonical out-of-band messages (target past
  // CURRENT, below the floor, store newer than this binary). Surface them as-is.
  let plan: ReturnType<typeof planMigration>;
  try {
    plan = planMigration(current, target);
  } catch (e) {
    console.error(chalk.red(`db migrate: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }

  if (plan.direction === "none") {
    console.log(chalk.dim(`already at v${current}; nothing to migrate`));
    return 0;
  }

  const arrow = plan.direction === "down" ? "↓" : "→";
  const willBackup = !opts.noBackup;
  if (opts.dryRun) {
    console.log(`would ${plan.direction}-migrate ${storePath}: v${current} ${arrow} v${target}`);
    for (const s of plan.steps) {
      const cls =
        s.class === "irreversible" ? chalk.red(s.class) : s.class === "lossy" ? chalk.yellow(s.class) : s.class;
      const reason = s.reason ? chalk.dim(` (${s.reason})`) : "";
      console.log(chalk.dim(`  ${plan.direction === "down" ? "down" : "up"} v${s.version} [${cls}]${reason}`));
    }
    console.log(
      chalk.dim(willBackup ? "  backup: yes (pre-migrate dump beside the store)" : "  backup: skipped (--no-backup)"),
    );
    return 0;
  }

  // Liveness gate: a live harness auto-migrates under its lock and would race
  // this walk. Stale heartbeat ⇒ treated as dead (same TTL the reaper uses).
  if (heartbeatAt != null && Date.now() - heartbeatAt < DAEMON_LOCK_TTL_MS) {
    console.error(chalk.red("db migrate: a harness is running against this store (live daemon_lock) — stop it first"));
    return 1;
  }

  if (willBackup) {
    const dest = backupPath(storePath, current, target, Date.now());
    serializeTo(storePath, dest);
    console.log(chalk.dim(`backup: ${dest}`));
  }

  const db = new Database(storePath);
  try {
    migrateTo(db, target, { allowDataLoss: opts.allowDataLoss ?? false });
  } catch (e) {
    console.error(chalk.red(`db migrate: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  } finally {
    db.close();
  }
  console.log(chalk.green(`migrated ${storePath}: v${current} ${arrow} v${target}`));
  return 0;
}
