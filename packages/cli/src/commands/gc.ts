// `swarm gc --branches` — prune `swarm/runs/*` branches whose runs are
// older than the retention window. The branch is the only artifact
// `dispose()` leaves behind, so without GC the refspace grows linearly
// with run count. See `docs/proposals/run-isolation.md`.
//
// Default retention: 30 days. Source of truth for "how old": the run's
// `run_state.updated_at`, which freezes once the terminal fact applies
// (no later writes mutate it). Branches with no matching run row (e.g.
// the run was deleted, or the branch was created out of band) are kept
// — we only delete what we can prove we own.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";

const SWARM_RUN_BRANCH_PREFIX = "swarm/runs/";
const DEFAULT_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;

export interface GcCommandOptions {
  /** What to garbage-collect. Branches today; future hooks (worktrees,
   * blobs) reuse this command surface. */
  target: "branches";
  /** Repo root the branches live in. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit DB path. Default `<cwd>/.swarm/swarm.db`. */
  dbPath?: string;
  /** Retention window in ms. Default 30 days. */
  olderThanMs?: number;
  /** When true, print actions instead of taking them. */
  dryRun?: boolean;
}

export async function gcCommand(opts: GcCommandOptions): Promise<number> {
  if (opts.target !== "branches") {
    console.error(chalk.red(`gc: unknown target "${opts.target}"`));
    return 1;
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".swarm/swarm.db");
  if (!existsSync(dbPath)) {
    console.error(chalk.red(`gc --branches: no store at ${dbPath}`));
    return 1;
  }
  const olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  const cutoff = Date.now() - olderThanMs;
  const dryRun = opts.dryRun === true;

  const branches = await listSwarmRunBranches(cwd);
  if (branches.length === 0) {
    console.log(chalk.dim("gc --branches: no swarm/runs/* branches found"));
    return 0;
  }

  const store = new SqliteStore({ path: dbPath });
  let deleted = 0;
  let kept = 0;
  let unknown = 0;
  try {
    for (const branch of branches) {
      const runId = branch.slice(SWARM_RUN_BRANCH_PREFIX.length);
      const state = store.getState(runId);
      if (state == null) {
        // Branch with no matching run row — leave it alone, the operator
        // may have created it manually or pruned the DB selectively.
        unknown += 1;
        if (dryRun) console.log(chalk.dim(`  skip ${branch} — no run_state row`));
        continue;
      }
      if (state.updatedAt >= cutoff) {
        kept += 1;
        continue;
      }
      if (dryRun) {
        console.log(chalk.yellow(`  would delete ${branch} (status=${state.status}, age=${ageStr(state.updatedAt)})`));
      } else {
        try {
          await runGit(cwd, ["branch", "-D", branch]);
          console.log(chalk.green(`  deleted ${branch} (status=${state.status}, age=${ageStr(state.updatedAt)})`));
        } catch (err) {
          console.error(chalk.red(`  failed to delete ${branch}: ${err instanceof Error ? err.message : String(err)}`));
          continue;
        }
      }
      deleted += 1;
    }
  } finally {
    store.close();
  }

  const verb = dryRun ? "would delete" : "deleted";
  console.log(
    chalk.bold(
      `gc --branches: ${verb} ${deleted}, kept ${kept} within retention, ` + `${unknown} unknown (no run row).`,
    ),
  );
  return 0;
}

async function listSwarmRunBranches(cwd: string): Promise<string[]> {
  const { stdout } = await runGitCapture(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${SWARM_RUN_BRANCH_PREFIX}`,
  ]);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(SWARM_RUN_BRANCH_PREFIX));
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
