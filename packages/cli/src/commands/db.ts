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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getFraguaHome } from "@fragua/agent";
import {
  applyPragmas,
  CURRENT_SCHEMA_VERSION,
  DAEMON_LOCK_TTL_MS,
  migrateTo,
  planMigration,
  SqliteStore,
} from "@fragua/store";
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
      console.log(chalk.green(`deleted ${deleted} orphan blob row(s) in ${storePath}`));
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

/** Remove a pre-migrate backup that turned out redundant — the migrate never
 * mutated the store (a liveness abort, or a transactional walk that rolled
 * back), so the dump is just a copy of the intact store and would otherwise
 * read as a successful checkpoint. */
function cleanupBackup(backupDest: string | null): void {
  if (backupDest != null && existsSync(backupDest)) rmSync(backupDest);
}

/** `<storePath dir>/backups/pre-migrate-v{from}-to-v{to}-<ts>.db`. Lives beside
 * the store being migrated, so a `--db` project store backs up next to itself
 * rather than into the global `~/.fragua`. */
function backupPath(storePath: string, from: number, to: number, ts: number): string {
  return join(dirname(storePath), "backups", `pre-migrate-v${from}-to-v${to}-${ts}.db`);
}

/** A harness running against this store auto-migrates under its lock and would
 * race a `db migrate` walk. Read-only probe of the `daemon_lock` heartbeat.
 * A lock is live until its heartbeat ages PAST the TTL — `<=` matches the
 * reaper, which reclaims only when `age > DAEMON_LOCK_TTL_MS` (entrypoint.ts);
 * at exactly the TTL both treat the lock as still alive, so they can't disagree
 * about that boundary tick. */
function daemonLive(storePath: string): boolean {
  const probe = new Database(storePath, { readonly: true });
  try {
    const hasLock = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_lock'").get();
    if (hasLock == null) return false;
    const heartbeatAt =
      probe.query<{ heartbeat_at: number }, []>("SELECT heartbeat_at FROM daemon_lock WHERE id = 1").get()
        ?.heartbeat_at ?? null;
    return heartbeatAt != null && Date.now() - heartbeatAt <= DAEMON_LOCK_TTL_MS;
  } finally {
    probe.close();
  }
}

function migrateDb(storePath: string, opts: DbCommandOptions): number {
  // Read the current version + daemon liveness WITHOUT mutating. The
  // store-client open mode (`migrate:false`) throws on an out-of-band version —
  // exactly the case `db migrate` exists to resolve — so probe the raw rows.
  const probe = new Database(storePath, { readonly: true });
  let current: number | null;
  try {
    const hasVersion = probe.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    current = hasVersion
      ? (probe.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get()?.version ?? null)
      : null;
  } finally {
    probe.close();
  }

  if (current === null) {
    console.error(chalk.red("db migrate: store is uninitialized (no schema_version) — start the harness to create it"));
    return 1;
  }

  // Validate the literal before `Number`: `Number.isInteger` accepts "2.0",
  // "0x2", "2e0", "  2 " (all coerce to whole numbers), silently migrating to a
  // version the operator didn't type. Require a plain integer string.
  if (opts.to !== undefined && !/^-?\d+$/.test(opts.to)) {
    console.error(chalk.red(`db migrate: --to expects an integer schema version, got "${opts.to}"`));
    return 1;
  }
  const target = opts.to !== undefined ? Number(opts.to) : CURRENT_SCHEMA_VERSION;

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
  // this walk.
  if (daemonLive(storePath)) {
    console.error(chalk.red("db migrate: a harness is running against this store (live daemon_lock) — stop it first"));
    return 1;
  }

  let backupDest: string | null = null;
  if (willBackup) {
    backupDest = backupPath(storePath, current, target, Date.now());
    serializeTo(storePath, backupDest);
    console.log(chalk.dim(`backup: ${backupDest}`));
  }

  // Re-check after the (possibly slow) backup: a harness could have started in
  // the gap between the first gate and opening the write connection. This
  // narrows but doesn't fully close the window — a daemon starting between here
  // and migrateTo's first write contends on the write lock, and the in-txn
  // version re-read refuses a state planMigration didn't validate.
  if (daemonLive(storePath)) {
    cleanupBackup(backupDest);
    console.error(
      chalk.red("db migrate: a harness started against this store mid-migrate — aborted before any change"),
    );
    return 1;
  }

  const db = new Database(storePath);
  // Same pragma set the bootstrap migrate path uses: `busy_timeout` so a
  // concurrent reader waits instead of taking an instant SQLITE_BUSY, WAL, and
  // `foreign_keys=ON` for parity with normal operation. A down-step that rebuilds
  // an FK-bearing table uses `PRAGMA defer_foreign_keys=ON` (valid inside the
  // walk's transaction) rather than disabling enforcement on the connection.
  applyPragmas(db);
  try {
    migrateTo(db, target, { allowDataLoss: opts.allowDataLoss ?? false });
  } catch (e) {
    // The walk is transactional, so a failure rolled back to the intact store —
    // the pre-migrate backup is now a redundant copy of it.
    cleanupBackup(backupDest);
    console.error(chalk.red(`db migrate: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  } finally {
    db.close();
  }
  console.log(chalk.green(`migrated ${storePath}: v${current} ${arrow} v${target}`));
  return 0;
}
