// `swarm db <action>` — DB maintenance.
//   vacuum    — reclaim free pages (VACUUM).
//   gc-blobs  — delete orphaned rows in the `blobs` table (no artifact refs).
//   backup    — SQLite online backup API into a target path.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";

export interface DbCommandOptions {
  action: "vacuum" | "gc-blobs" | "backup";
  cwd?: string;
  /** For `backup` — destination path. */
  to?: string;
  /** For `gc-blobs` — max rows to remove in one pass. */
  limit?: number;
}

export async function dbCommand(opts: DbCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = resolve(cwd, ".swarm/swarm.db");
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
  }
}
