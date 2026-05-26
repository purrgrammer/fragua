// `fragua runs export <id> --to <f.fragua>` / `fragua runs import <f.fragua>` —
// move a run between stores as a portable, secret-free `.fragua` bundle
// (docs/proposals/db-import.md).
//
// Both are migrate:false store-clients (the harness/daemon owns migration, so a
// client never upgrades a schema): export reads a run that must already exist;
// import lands in an existing target store (default: the harness store). The
// bundle never carries provider tables, so it's secret-free by construction.
//
// Tree state (db-import §3.2): export shells `git bundle create` from the run's
// refs into a `git-bundle` entry (the store can't shell git); `import
// --rehydrate` fetches those objects into a host repo, recreates the refs, and
// checks out the snapshot tip as a worktree — exactly the per-run worktree a
// native run uses — so `runs diff` works against the imported run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readTar } from "@fragua/store";
import { buildRunGitBundle, defaultGitExec, type GitExec, rehydrateRunWorktree } from "@fragua/workspace";
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
 *  must already exist. Carries tree state (a git-bundle) when the run had a
 *  worktree whose refs are still reachable — else rows + artifact blobs only. */
export function exportCommand(opts: ExportOptions): Promise<number> {
  return withStoreClient(opts, async ({ store }) => {
    const run = store.getState(opts.runId);
    if (run == null) {
      console.error(chalk.red("export: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const dest = resolve(opts.to);
    mkdirSync(dirname(dest), { recursive: true });

    let gitBundle: Uint8Array | undefined;
    if (run.cwd != null) {
      try {
        const gb = await buildRunGitBundle(defaultGitExec, run.cwd, opts.runId, run.baseGitSha, run.diffBaseSha);
        if (gb != null) gitBundle = gb;
      } catch {
        // Best-effort: fall through to a rows-only export.
      }
    }

    try {
      writeFileSync(
        dest,
        store.exportRunBundle(opts.runId, {
          fraguaVersion: FRAGUA_VERSION,
          ...(gitBundle != null ? { gitBundle } : {}),
        }),
      );
    } catch (err) {
      console.error(chalk.red(`export: ${(err as Error).message}`));
      return 1;
    }
    console.log(
      chalk.green(`exported run ${opts.runId} → ${dest}`) + (gitBundle != null ? chalk.dim("  (+ tree state)") : ""),
    );
    return 0;
  });
}

export interface ImportOptions extends DiscoveryOpts {
  /** Path to the `.fragua` bundle to merge in. */
  bundle: string;
  /** Reconstruct the run's worktree from the bundle's tree state (db-import §3.2). */
  rehydrate?: boolean;
  /** Host repo for `--rehydrate` (default: cwd; `git init`-ed if it doesn't exist). */
  into?: string;
}

/** Reconstruct an imported run's worktree from the bundle's git-bundle entry:
 *  fetch the objects + refs into a host repo, check out the snapshot tip as the
 *  per-run worktree, and rebind `cwd`. Then `runs diff <id>` resolves. */
async function rehydrateRun(
  git: GitExec,
  store: { setRunCwd: (runId: string, cwd: string) => void },
  runId: string,
  bundleBytes: Uint8Array,
  intoOpt: string | undefined,
): Promise<number> {
  const gb = readTar(bundleBytes).find((e) => e.name === "git-bundle");
  if (gb == null) {
    console.warn(chalk.yellow("  rehydrate: bundle carries no tree state (rows imported; nothing to reconstruct)"));
    return 0;
  }

  const host = resolve(intoOpt ?? process.cwd());
  const isRepo = (await git(host, ["rev-parse", "--is-inside-work-tree"])).exitCode === 0;
  if (!isRepo) {
    // Never `git init` the operator's working dir implicitly — only an explicit
    // --into target.
    if (intoOpt == null) {
      console.error(chalk.red(`rehydrate: ${host} is not a git repo (pass --into <repo>)`));
      return 1;
    }
    mkdirSync(host, { recursive: true });
    const init = await git(host, ["init", "-q"]);
    if (init.exitCode !== 0) {
      console.error(chalk.red(`rehydrate: git init failed: ${init.stderr.trim()}`));
      return 1;
    }
  }

  const res = await rehydrateRunWorktree(git, host, runId, gb.data);
  if (!res.ok) {
    console.error(chalk.red(`rehydrate: ${res.error}`));
    return 1;
  }
  store.setRunCwd(runId, host);
  console.log(chalk.green(`  rehydrated → ${res.worktree}`) + chalk.dim(`  (runs diff ${runId} now works)`));
  return 0;
}

/** Merge a `.fragua` bundle into the target store (default: the harness store)
 *  so the run is inspectable here. A migrate:false store-client like every other
 *  runs verb — never upgrades a schema, and errors if the target store is absent
 *  (start the harness, or point `--db` at an existing store). With `--rehydrate`
 *  it also reconstructs the run's worktree so `runs diff` works. */
export function importCommand(opts: ImportOptions): Promise<number> {
  const src = resolve(opts.bundle);
  if (!existsSync(src)) {
    console.error(chalk.red(`import: no bundle at ${src}`));
    return Promise.resolve(1);
  }
  const bytes = readFileSync(src);
  const storePath = resolveStorePath(opts);
  return withStoreClient(opts, async ({ store }) => {
    let result: { runId: string; imported: boolean; resumeCompatible: boolean; neutralized: boolean };
    try {
      result = store.importRunBundle(bytes);
    } catch (err) {
      console.error(chalk.red(`import: ${(err as Error).message}`));
      return 1;
    }
    const { runId, imported, resumeCompatible, neutralized } = result;
    console.log(
      imported
        ? chalk.green(`imported run ${runId} → ${storePath}`)
        : chalk.dim(`run ${runId} already present in ${storePath} (no-op)`),
    );
    if (neutralized) {
      console.warn(
        chalk.yellow(
          "  note: run was mid-flight at export; landed terminal here (inspect-only — " +
            "resume-after-import is not yet supported)",
        ),
      );
    }
    if (!resumeCompatible) {
      console.warn(
        chalk.yellow(
          "  note: this run's engine contract is outside this build's range — " +
            "inspect works, but resume will park until the binary catches up",
        ),
      );
    }
    if (opts.rehydrate) {
      return rehydrateRun(defaultGitExec, store, runId, bytes, opts.into);
    }
    return 0;
  });
}
