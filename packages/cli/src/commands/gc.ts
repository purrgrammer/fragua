// `fragua gc` — reclaim per-run worktree artefacts. Two targets, either or
// both per invocation:
//   - `--snapshots`: the two non-porcelain refs `refs/fragua/snapshots/<runId>`
//     (the parented tip) and `refs/fragua/heads/<runId>`; deleting the tip
//     drops the whole chain so the next `git gc --auto` reclaims its commits +
//     trees + blobs. A trailing `git pack-refs --all` keeps the live set compact.
//   - `--worktrees`: the leftover `.fragua/worktrees/<runId>` directory AND its
//     git registration, then a `git worktree prune` so a hand-deleted directory
//     stops blocking branch checkout. Non-settled (`queued`/`running`/`paused*`)
//     and `quarantined` runs are never touched — their work is live or resumable.
//
// Retention (operator-invoked, not an automatic sweep — pairs with the
// `fragua db prune` model):
//   - `inbox_status = 'pending'`  → kept (operator hasn't decided).
//   - everything else, once the run is settled and older than the window
//     (default 30d) → eligible. `acted` runs are kept inside the window so
//     branch/commit/merge can still compose; `discarded` runs already had
//     their refs deleted (a no-op here); clean (`NULL`) runs lose only their
//     reclaimable git objects — the run row + event log stay queryable.
//
// "How old" is `run_state.updated_at`, frozen once the terminal fact lands.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";

const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;

export interface GcCommandOptions {
  /** Reclaim worktree snapshot refs (`refs/fragua/{snapshots,heads}/<id>`)
   * for eligible runs. */
  snapshots?: boolean;
  /** Remove leftover worktree directories + git registrations for eligible
   * runs, then `git worktree prune` any registration whose directory is gone. */
  worktrees?: boolean;
  /** Repo root the refs / worktrees live in. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit DB path. Default `<cwd>/.fragua/fragua.db`. */
  dbPath?: string;
  /** Retention window in ms. Default 30 days. */
  olderThanMs?: number;
  /** When true, print actions instead of taking them. */
  dryRun?: boolean;
}

export async function gcCommand(opts: GcCommandOptions): Promise<number> {
  if (opts.snapshots !== true && opts.worktrees !== true) {
    console.error(chalk.red("gc: at least one of --snapshots / --worktrees is required"));
    return 1;
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".fragua/fragua.db");
  if (!existsSync(dbPath)) {
    console.error(chalk.red(`gc --snapshots: no store at ${dbPath}`));
    return 1;
  }
  const olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  const cutoff = Date.now() - olderThanMs;
  const dryRun = opts.dryRun === true;

  const doSnapshots = opts.snapshots === true;
  const doWorktrees = opts.worktrees === true;

  const store = new SqliteStore({ path: dbPath });
  let runsCleaned = 0;
  let refsDeleted = 0;
  let worktreesRemoved = 0;
  try {
    const eligible = store.getGcEligibleSnapshotRuns({ cwd, cutoff });

    if (doSnapshots) {
      const existing = await listFraguaRefs(cwd);
      for (const run of eligible) {
        const refs = [`refs/fragua/snapshots/${run.runId}`, `refs/fragua/heads/${run.runId}`].filter((r) =>
          existing.has(r),
        );
        if (refs.length === 0) continue; // bare-cwd run, or already discarded
        if (dryRun) {
          console.log(
            chalk.yellow(
              `  would delete ${refs.length} ref(s) for ${run.runId} (status=${run.status}, age=${ageStr(run.updatedAt)})`,
            ),
          );
          runsCleaned += 1;
          refsDeleted += refs.length;
          continue;
        }
        for (const ref of refs) {
          try {
            await runGit(cwd, ["update-ref", "-d", ref]);
            refsDeleted += 1;
          } catch (err) {
            console.error(chalk.red(`  failed to delete ${ref}: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        runsCleaned += 1;
      }
    }

    if (doWorktrees) {
      const registered = await listRegisteredWorktrees(cwd);
      for (const run of eligible) {
        const gitPath = registered.get(run.runId);
        const dir = resolve(cwd, ".fragua/worktrees", run.runId);
        if (gitPath == null && !existsSync(dir)) continue; // bare-cwd run, or already reaped
        if (dryRun) {
          console.log(
            chalk.yellow(
              `  would remove worktree for ${run.runId} (status=${run.status}, age=${ageStr(run.updatedAt)})`,
            ),
          );
          worktreesRemoved += 1;
          continue;
        }
        try {
          if (gitPath != null) await runGit(cwd, ["worktree", "remove", "--force", gitPath]);
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          worktreesRemoved += 1;
        } catch (err) {
          console.error(
            chalk.red(
              `  failed to remove worktree for ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
      }
    }
  } finally {
    store.close();
  }

  if (doSnapshots && !dryRun && refsDeleted > 0) {
    try {
      await runGit(cwd, ["pack-refs", "--all"]);
    } catch (err) {
      console.error(
        chalk.yellow(`  pack-refs --all failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  // Prune runs unconditionally in the worktree sweep: its whole point is to
  // clear registrations whose directory was hand-deleted, which no per-run
  // removal above would touch.
  if (doWorktrees && !dryRun) {
    try {
      await runGit(cwd, ["worktree", "prune"]);
    } catch (err) {
      console.error(
        chalk.yellow(`  worktree prune failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  if (doSnapshots) {
    const verb = dryRun ? "would delete" : "deleted";
    console.log(chalk.bold(`gc --snapshots: ${verb} ${refsDeleted} ref(s) across ${runsCleaned} run(s).`));
  }
  if (doWorktrees) {
    const verb = dryRun ? "would remove" : "removed";
    console.log(chalk.bold(`gc --worktrees: ${verb} ${worktreesRemoved} worktree(s).`));
  }
  return 0;
}

/** Registered worktrees under `<cwd>/.fragua/worktrees/`, keyed by run id.
 * The value is git's own registered path (used verbatim for removal) so a
 * canonicalised path — e.g. macOS `/private/var` vs `/var` — still matches. */
async function listRegisteredWorktrees(cwd: string): Promise<Map<string, string>> {
  const { stdout } = await runGitCapture(cwd, ["worktree", "list", "--porcelain"]);
  const byRunId = new Map<string, string>();
  const marker = "/.fragua/worktrees/";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length).trim();
    const idx = path.lastIndexOf(marker);
    if (idx === -1) continue;
    const runId = path.slice(idx + marker.length);
    if (runId.length === 0 || runId.includes("/")) continue;
    byRunId.set(runId, path);
  }
  return byRunId;
}

/** Every existing `refs/fragua/{snapshots,heads}/*` ref in `cwd`, by full name. */
async function listFraguaRefs(cwd: string): Promise<Set<string>> {
  const { stdout } = await runGitCapture(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/fragua/snapshots/",
    "refs/fragua/heads/",
  ]);
  return new Set(
    stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function ageStr(updatedAt: number): string {
  const days = Math.floor((Date.now() - updatedAt) / (24 * 60 * 60 * 1000));
  if (days < 1) return "<1d";
  return `${days}d`;
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", rejectPromise);
  });
}

function runGitCapture(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", rejectPromise);
  });
}

/** Parse a duration like "30d", "12h", "2w". Returns ms.
 * Empty / null returns the default. Throws on unparseable input. */
export function parseDuration(input: string | undefined): number {
  if (input == null || input.trim() === "") return DEFAULT_OLDER_THAN_MS;
  const match = /^(\d+)\s*(d|h|w|m)$/i.exec(input.trim());
  if (match == null) {
    throw new Error(`invalid duration "${input}" — expected forms like 30d, 12h, 2w, 90m`);
  }
  const n = Number.parseInt(match[1] ?? "0", 10);
  switch (match[2]?.toLowerCase()) {
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "d":
      return n * 24 * 60 * 60 * 1000;
    case "w":
      return n * 7 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration "${input}"`);
  }
}
