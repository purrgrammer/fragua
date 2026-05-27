// `fragua runs export <id> --to <f.fragua>` / `fragua import <f.fragua>` —
// move runs between stores as a portable, secret-free `.fragua` bundle
// (docs/proposals/archive/bundles.md).
//
// Both are migrate:false store-clients (the harness/daemon owns migration, so a
// client never upgrades a schema): export reads a run that must already exist;
// import merges into an existing target store (default: the harness store),
// re-deriving `run_state` by replaying each run's event log. The bundle never
// carries provider tables, so it's secret-free by construction.

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

/** Write `runId` as a portable `.fragua` bundle. Read-only store-client; the run
 *  must already exist. Carries the run's event log, transcript, workflow, and
 *  artifact blobs — `run_state` is re-derived on import, not bundled. */
export function exportCommand(opts: ExportOptions): Promise<number> {
  return withStoreClient(opts, ({ store }) => {
    const run = store.getState(opts.runId);
    if (run == null) {
      console.error(chalk.red("export: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const dest = resolve(opts.to);
    mkdirSync(dirname(dest), { recursive: true });
    let bytes: Uint8Array;
    let liveLiteralHit: boolean;
    try {
      ({ bytes, liveLiteralHit } = store.exportRunBundle(opts.runId, { fraguaVersion: FRAGUA_VERSION }));
    } catch (err) {
      console.error(chalk.red(`export: ${(err as Error).message}`));
      return 1;
    }
    writeFileSync(dest, bytes);
    if (liveLiteralHit) {
      console.warn(chalk.yellow(`export: bundle contains a provider-credential literal — review before sharing`));
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
 *  so its runs are inspectable here. A migrate:false store-client like every
 *  other verb — never upgrades a schema, and errors if the target store is
 *  absent (start the harness, or point `--db` at an existing store). Each run's
 *  `run_state` is derived by replaying its event log; an imported run is inert
 *  (its derived `cwd` is null), so the daemon never picks it up. */
export function importCommand(opts: ImportOptions): Promise<number> {
  const src = resolve(opts.bundle);
  if (!existsSync(src)) {
    console.error(chalk.red(`import: no bundle at ${src}`));
    return Promise.resolve(1);
  }
  const bytes = readFileSync(src);
  const storePath = resolveStorePath(opts);
  return withStoreClient(opts, ({ store }) => {
    let result: { runs: { runId: string; imported: boolean }[]; resumeCompatible: boolean };
    try {
      result = store.importRunBundle(bytes);
    } catch (err) {
      console.error(chalk.red(`import: ${(err as Error).message}`));
      return 1;
    }
    for (const { runId, imported } of result.runs) {
      console.log(
        imported
          ? chalk.green(`imported run ${runId} → ${storePath}`) + chalk.dim("  (inspect-only; inert here)")
          : chalk.dim(`run ${runId} already present in ${storePath} (no-op)`),
      );
    }
    if (!result.resumeCompatible) {
      console.warn(
        chalk.yellow(
          "  note: this bundle's engine contract is outside this build's range — inspect works, resume does not",
        ),
      );
    }
    return 0;
  });
}
