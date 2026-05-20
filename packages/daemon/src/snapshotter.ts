// Worktree tree snapshots (docs/proposals/worktrees.md). Pure git-plumbing
// utility: captures the worktree's working-tree state (including uncommitted
// dirt and untracked files) as a commit under a non-porcelain ref namespace,
// without disturbing the workflow's real index or HEAD.
//
// Mechanism per the proposal's "Snapshot capture sequence":
//   - a per-worktree sentinel index (resolved via `git rev-parse --git-path
//     swarm-index`, so it works in a LINKED worktree where `.git` is a file)
//     seeded from the real index for a warm stat cache,
//   - `git add -A` + `write-tree` into the sentinel (never touches `.git/index`),
//   - `commit-tree` parented to the previous snapshot (lineage),
//   - a single per-run tip ref `refs/swarm/snapshots/<runId>` moved forward —
//     the parent chain keeps every prior snapshot reachable, so intermediate
//     snapshots are addressed by `commitSha`, not per-eventIdx refs,
//   - `refs/swarm/heads/<runId>` tracking HEAD when it has moved off base.
//
// Dormant: not wired into the executor yet (that is step 3).

import { execFile } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** A boundary at which a snapshot is taken. `step` snapshots are lean
 * (no stats); `hitl` / `terminal` additionally carry the honest diff. */
export type SnapshotBoundary = "step" | "hitl" | "terminal";

export type SnapshotStat = {
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type CaptureSnapshotOpts = {
  /** Absolute path of the worktree to snapshot. */
  worktree: string;
  runId: string;
  /** HEAD sha at provision — the diff base and the heads-ref gate.
   * Empty string for an unborn source repo (no base commit). */
  baseGitSha: string;
  /** Commit sha of the previous recorded snapshot (lineage parent), or
   * `baseGitSha` for the first snapshot. Empty → a parentless root commit. */
  parentSnap: string;
  boundary: SnapshotBoundary;
  /** Previous recorded snapshot's `treeSha`. When this equals the freshly
   * computed tree on a `step` boundary the snapshot is suppressed (returns
   * null) — read-only steps cost a probe but write nothing. */
  prevTreeSha?: string | null;
};

export type SnapshotResult = {
  treeSha: string;
  commitSha: string;
  /** Lineage parent (the previous snapshot's commit, or baseGitSha for the
   * first). Carried so the caller can stamp the event payload. */
  parentSnap: string;
  headSha: string;
  /** Present on `hitl` / `terminal` boundaries only. */
  headRef?: string | null;
  diffBaseSha?: string;
  committed?: SnapshotStat | null;
  uncommitted?: SnapshotStat | null;
};

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

/** `update-ref` against a shared ref store can race on `packed-refs` /
 * loose-ref locks when many runs snapshot concurrently. Bounded retry. */
async function updateRefWithRetry(cwd: string, ref: string, sha: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await git(cwd, ["update-ref", ref, sha]);
      return;
    } catch (err) {
      const msg = String(err);
      const lockContention = /unable to (?:lock|create|update)|\.lock|cannot lock ref/i.test(msg);
      if (attempt >= maxAttempts || !lockContention) throw err;
      await new Promise((r) => setTimeout(r, 40 * attempt));
    }
  }
}

/** Parse `git diff --shortstat` output. Empty output (no changes) → null. */
export function parseShortstat(out: string): SnapshotStat | null {
  if (out.trim() === "") return null;
  const files = /(\d+) files? changed/.exec(out);
  const ins = /(\d+) insertions?\(\+\)/.exec(out);
  const del = /(\d+) deletions?\(-\)/.exec(out);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/**
 * Resolve the lineage parent for the next snapshot: the run's existing tip
 * ref `refs/swarm/snapshots/<runId>` if present (so a daemon that restarted
 * mid-run continues the chain — keeping every prior snapshot reachable under
 * the single tip), else `baseGitSha`. The executor prefers its in-memory
 * cursor and only falls back here on a cold resume.
 */
export async function resolveSnapshotParent(worktree: string, runId: string, baseGitSha: string): Promise<string> {
  try {
    const sha = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/swarm/snapshots/${runId}`]);
    return sha !== "" ? sha : baseGitSha;
  } catch {
    return baseGitSha;
  }
}

/**
 * Capture a snapshot of `worktree`. Returns the result, or `null` when a
 * `step` snapshot is delta-suppressed (tree unchanged since `prevTreeSha`).
 *
 * Side effects: moves `refs/swarm/snapshots/<runId>` forward and, when HEAD
 * has moved off `baseGitSha`, updates `refs/swarm/heads/<runId>`. The sentinel
 * index is created and removed within the call; the real index and HEAD are
 * never touched.
 */
export async function captureSnapshot(opts: CaptureSnapshotOpts): Promise<SnapshotResult | null> {
  const { worktree, runId, baseGitSha, parentSnap, boundary, prevTreeSha } = opts;

  const gitPath = async (name: string): Promise<string> => {
    const p = await git(worktree, ["rev-parse", "--git-path", name]);
    return isAbsolute(p) ? p : join(worktree, p);
  };

  const swarmIndex = await gitPath("swarm-index");
  // Seed from the real index so `add -A` re-hashes only changed files. A
  // fresh worktree always has an index; tolerate its absence regardless.
  try {
    await copyFile(await gitPath("index"), swarmIndex);
  } catch {
    // no real index yet — start from an empty sentinel (full rehash).
  }
  const idxEnv = { GIT_INDEX_FILE: swarmIndex };

  try {
    await git(worktree, ["add", "-A"], idxEnv);
    const treeSha = await git(worktree, ["write-tree"], idxEnv);

    if (boundary === "step" && prevTreeSha != null && prevTreeSha === treeSha) {
      return null;
    }

    const commitArgs = ["commit-tree", treeSha, "-m", `swarm-snapshot:${runId}:${boundary}`];
    if (parentSnap !== "") commitArgs.push("-p", parentSnap);
    const commitSha = await git(worktree, commitArgs);

    await updateRefWithRetry(worktree, `refs/swarm/snapshots/${runId}`, commitSha);

    const headSha = await git(worktree, ["rev-parse", "HEAD"]);
    if (baseGitSha !== "" && headSha !== baseGitSha) {
      await updateRefWithRetry(worktree, `refs/swarm/heads/${runId}`, headSha);
    }

    const result: SnapshotResult = { treeSha, commitSha, parentSnap, headSha };

    if (boundary !== "step") {
      let headRef: string | null = null;
      try {
        headRef = (await git(worktree, ["symbolic-ref", "--short", "HEAD"])) || null;
      } catch {
        headRef = null; // detached / tag / unborn
      }

      // Honest diff base: base when the workflow committed on top of it, the
      // fork point when it checked out an unrelated line. merge-base(base,
      // HEAD) == base exactly when base is an ancestor of HEAD.
      let diffBaseSha = baseGitSha;
      if (baseGitSha !== "") {
        try {
          diffBaseSha = await git(worktree, ["merge-base", baseGitSha, "HEAD"]);
        } catch {
          diffBaseSha = baseGitSha;
        }
      }

      const committed =
        baseGitSha !== "" ? parseShortstat(await git(worktree, ["diff", "--shortstat", diffBaseSha, headSha])) : null;
      const uncommitted = parseShortstat(await git(worktree, ["diff", "--shortstat", headSha, commitSha]));

      result.headRef = headRef;
      result.diffBaseSha = diffBaseSha;
      result.committed = committed;
      result.uncommitted = uncommitted;
    }

    return result;
  } finally {
    await rm(swarmIndex, { force: true });
  }
}
