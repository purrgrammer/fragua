// `fragua runs export <id> --to <f.fragua>` / `fragua runs import <f.fragua>` —
// move a run between stores as a portable, secret-free `.fragua` bundle
// (docs/proposals/db-import.md).
//
// Both are migrate:false store-clients (the harness/daemon owns migration, so a
// client never upgrades a schema): export reads a run that must already exist;
// import lands in an existing target store (default: the harness store). The
// bundle never carries provider tables, so it's secret-free by construction.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import { resolveStorePath, withStoreClient } from "../store-client.ts";
import { FRAGUA_VERSION } from "../version.ts";

interface DiscoveryOpts {
  cwd?: string;
  dbPath?: string;
}

export interface ExportOptions extends DiscoveryOpts {
  runId: string;
  /** Destination path for the `.fragua` bundle. */
  to: string;
}

/** Write `runId` as a portable `.fragua` bundle. Read-only store-client; the
 *  run must already exist in the source store. */
export function exportCommand(opts: ExportOptions): Promise<number> {
  return withStoreClient(opts, ({ store }) => {
    if (store.getState(opts.runId) == null) {
      console.error(chalk.red("export: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const dest = resolve(opts.to);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      writeFileSync(dest, store.exportRunBundle(opts.runId, { fraguaVersion: FRAGUA_VERSION }));
    } catch (err) {
      console.error(chalk.red(`export: ${(err as Error).message}`));
      return 1;
    }
    console.log(chalk.green(`exported run ${opts.runId} → ${dest}`));
    return 0;
  });
}

export interface ImportOptions extends DiscoveryOpts {
  /** Path to the `.fragua` bundle to merge in. */
  bundle: string;
}

/** Merge a `.fragua` bundle into the target store (default: the harness store)
 *  so the run is inspectable here. A migrate:false store-client like every other
 *  runs verb — never upgrades a schema, and errors if the target store is absent
 *  (start the harness, or point `--db` at an existing store). */
export function importCommand(opts: ImportOptions): Promise<number> {
  const src = resolve(opts.bundle);
  if (!existsSync(src)) {
    console.error(chalk.red(`import: no bundle at ${src}`));
    return Promise.resolve(1);
  }
  const bytes = readFileSync(src);
  const storePath = resolveStorePath(opts);
  return withStoreClient(opts, ({ store }) => {
    try {
      const { runId, imported } = store.importRunBundle(bytes);
      console.log(
        imported
          ? chalk.green(`imported run ${runId} → ${storePath}`)
          : chalk.dim(`run ${runId} already present in ${storePath} (no-op)`),
      );
      return 0;
    } catch (err) {
      console.error(chalk.red(`import: ${(err as Error).message}`));
      return 1;
    }
  });
}
