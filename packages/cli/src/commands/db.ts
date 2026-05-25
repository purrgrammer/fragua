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
import { dirname, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION, SqliteStore } from "@fragua/store";
import chalk from "chalk";
import { FRAGUA_VERSION } from "../version.ts";

export interface DbCommandOptions {
  action: "vacuum" | "gc-blobs" | "backup" | "migrate" | "export";
  cwd?: string;
  /** Explicit store path. Overrides `<cwd>/.fragua/fragua.db`. */
  dbPath?: string;
  /** For `backup` / `export` — destination path. */
  to?: string;
  /** For `export` — the run id to bundle. */
  run?: string;
  /** For `gc-blobs` — max rows to remove in one pass. */
  limit?: number;
  /** For `migrate` — print the plan without applying. */
  dryRun?: boolean;
}

export async function dbCommand(opts: DbCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".fragua/fragua.db");
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
    case "export": {
      if (opts.run == null || opts.run.length === 0) {
        console.error(chalk.red("db export: <run-id> required"));
        return 1;
      }
      if (opts.to == null || opts.to.length === 0) {
        console.error(chalk.red("db export: --to <path.fragua> required"));
        return 1;
      }
      const dest = resolve(cwd, opts.to);
      mkdirSync(dirname(dest), { recursive: true });
      // migrate:false — export reads; never mutate the source store's schema.
      const store = new SqliteStore({ path: storePath, migrate: false });
      try {
        writeFileSync(dest, store.exportRunBundle(opts.run, { fraguaVersion: FRAGUA_VERSION }));
      } catch (err) {
        console.error(chalk.red(`db export: ${(err as Error).message}`));
        return 1;
      } finally {
        store.close();
      }
      console.log(chalk.green(`exported run ${opts.run} → ${dest}`));
      return 0;
    }
    case "backup": {
      if (opts.to == null || opts.to.length === 0) {
        console.error(chalk.red("db backup: --to <path> required"));
        return 1;
      }
      const dest = resolve(cwd, opts.to);
      mkdirSync(dirname(dest), { recursive: true });
      // Use `serialize()` + writeFile rather than `VACUUM INTO` because
      // the target file's schema is replayed without the STORED generated
      // columns, so VACUUM INTO trips a column-count mismatch.
      const src = new Database(storePath, { readonly: true });
      try {
        const buf = src.serialize();
        writeFileSync(dest, buf);
      } finally {
        src.close();
      }
      console.log(chalk.green(`backed up to ${dest}`));
      return 0;
    }
    case "migrate": {
      // Read the current version WITHOUT mutating. The store-client open mode
      // (`migrate:false`) throws on an out-of-band version — exactly the case
      // `db migrate` exists to resolve — so probe the raw row instead.
      const probe = new Database(storePath, { readonly: true });
      let current: number | null;
      try {
        const hasTable = probe
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
          .get();
        current = hasTable
          ? (probe.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get()?.version ??
            null)
          : null;
      } finally {
        probe.close();
      }
      if (current === null) {
        console.error(
          chalk.red("db migrate: store is uninitialized (no schema_version) — start the harness to create it"),
        );
        return 1;
      }
      if (current > CURRENT_SCHEMA_VERSION) {
        console.error(
          chalk.red(
            `db migrate: store is v${current}, newer than this binary (v${CURRENT_SCHEMA_VERSION}) — upgrade fragua`,
          ),
        );
        return 1;
      }
      if (current < MIN_COMPATIBLE_SCHEMA_VERSION) {
        console.error(
          chalk.red(
            `db migrate: store is v${current}, below the supported floor (v${MIN_COMPATIBLE_SCHEMA_VERSION}) — no migration path`,
          ),
        );
        return 1;
      }
      if (current === CURRENT_SCHEMA_VERSION) {
        console.log(chalk.dim(`already at v${current}; nothing to migrate`));
        return 0;
      }
      if (opts.dryRun) {
        console.log(`would migrate ${storePath}: v${current} → v${CURRENT_SCHEMA_VERSION}`);
        return 0;
      }
      // The constructor runs the gated, transactional walk-forward migrate().
      new SqliteStore({ path: storePath }).close();
      console.log(chalk.green(`migrated ${storePath}: v${current} → v${CURRENT_SCHEMA_VERSION}`));
      return 0;
    }
  }
}
