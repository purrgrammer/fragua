// `fragua gc --snapshots` — reclaim worktree snapshot refs. Per-run snapshots
// live under two non-porcelain refs,
// `refs/fragua/snapshots/<runId>` (the parented tip) and
// `refs/fragua/heads/<runId>`; deleting the tip drops the whole chain so the
// next `git gc --auto` reclaims its commits + trees + blobs.
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
// A trailing `git pack-refs --all` keeps the live ref set compact.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";

const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;

export interface GcCommandOptions {
  /** What to garbage-collect. Worktree snapshot refs today. */
  target: "snapshots";
  /** Repo root the refs live in. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit DB path. Default `<cwd>/.fragua/fragua.db`. */
  dbPath?: string;
  /** Retention window in ms. Default 30 days. */
  olderThanMs?: number;
  /** When true, print actions instead of taking them. */
  dryRun?: boolean;
}

export async function gcCommand(opts: GcCommandOptions): Promise<number> {
  if (opts.target !== "snapshots") {
    console.error(chalk.red(`gc: unknown target "${opts.target}"`));
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

  const existing = await listFraguaRefs(cwd);
  const store = new SqliteStore({ path: dbPath });
  let runsCleaned = 0;
  let refsDeleted = 0;
  try {
    const eligible = store.getGcEligibleSnapshotRuns({ cwd, cutoff });
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
  } finally {
    store.close();
  }

  if (!dryRun && refsDeleted > 0) {
    try {
      await runGit(cwd, ["pack-refs", "--all"]);
    } catch (err) {
      console.error(
        chalk.yellow(`  pack-refs --all failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  const verb = dryRun ? "would delete" : "deleted";
  console.log(chalk.bold(`gc --snapshots: ${verb} ${refsDeleted} ref(s) across ${runsCleaned} run(s).`));
  return 0;
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
