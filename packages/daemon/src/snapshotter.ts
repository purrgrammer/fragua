// Worktree tree snapshots. Pure git-plumbing
// utility: captures the worktree's working-tree state (including uncommitted
// dirt and untracked files) as a commit under a non-porcelain ref namespace,
// without disturbing the workflow's real index or HEAD.
//
// Mechanism per the proposal's "Snapshot capture sequence":
//   - the shared `captureTree` (@fragua/workspace): a per-call sentinel index
//     `fragua-index-<runId>-<nonce>` in the worktree's own git dir, seeded from
//     the real index, `git add -A` + `write-tree` into it (never `.git/index`),
//   - `commit-tree` parented to the previous snapshot (lineage),
//   - a single per-run tip ref `refs/fragua/snapshots/<runId>` moved forward —
//     the parent chain keeps every prior snapshot reachable, so intermediate
//     snapshots are addressed by `commitSha`, not per-eventIdx refs,
//   - `refs/fragua/heads/<runId>` tracking HEAD when it has moved off base.
//
// Dormant: not wired into the executor yet (that is step 3).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureTree, parseShortstat, SNAPSHOT_IDENT, updateRefWithRetry } from "@fragua/workspace";

export { parseShortstat };

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

async function git(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

/**
 * Resolve the lineage parent for the next snapshot: the run's existing tip
 * ref `refs/fragua/snapshots/<runId>` if present (so a daemon that restarted
 * mid-run continues the chain — keeping every prior snapshot reachable under
 * the single tip), else `baseGitSha`. The executor prefers its in-memory
 * cursor and only falls back here on a cold resume.
 */
export async function resolveSnapshotParent(worktree: string, runId: string, baseGitSha: string): Promise<string> {
  try {
    const sha = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/fragua/snapshots/${runId}`]);
    return sha !== "" ? sha : baseGitSha;
  } catch {
    return baseGitSha;
  }
}

/**
 * Capture a snapshot of `worktree`. Returns the result, or `null` when a
 * `step` snapshot is delta-suppressed (tree unchanged since `prevTreeSha`).
 *
 * Side effects: moves `refs/fragua/snapshots/<runId>` forward and, when HEAD
 * has moved off `baseGitSha`, updates `refs/fragua/heads/<runId>`. The sentinel
 * index is created and removed within the call; the real index and HEAD are
 * never touched.
 */
export async function captureSnapshot(opts: CaptureSnapshotOpts): Promise<SnapshotResult | null> {
  const { worktree, runId, baseGitSha, parentSnap, boundary, prevTreeSha } = opts;

  // The worktree is never run.cwd's checkout, so no state excludes apply.
  const treeSha = await captureTree({ dir: worktree, label: runId, excludes: [] });
  if (boundary === "step" && prevTreeSha != null && prevTreeSha === treeSha) {
    return null;
  }

  const commitArgs = ["commit-tree", treeSha, "-m", `fragua-snapshot:${runId}:${boundary}`];
  if (parentSnap !== "") commitArgs.push("-p", parentSnap);
  const commitSha = await git(worktree, commitArgs, SNAPSHOT_IDENT);

  await updateRefWithRetry(worktree, `refs/fragua/snapshots/${runId}`, commitSha);

  const headSha = await git(worktree, ["rev-parse", "HEAD"]);
  if (baseGitSha !== "" && headSha !== baseGitSha) {
    await updateRefWithRetry(worktree, `refs/fragua/heads/${runId}`, headSha);
  }

  const result: SnapshotResult = { treeSha, commitSha, parentSnap, headSha };

  // Diff stats feed the Diff selector and the inbox change-stat — computed
  // at EVERY boundary (step included) so each selectable snapshot shows its
  // delta, not just the hitl/terminal ones. Honest diff base: base when the
  // workflow committed on top of it, the fork point when it checked out an
  // unrelated line. merge-base(base, HEAD) == base exactly when base is an
  // ancestor of HEAD; skip it (and the committed diff) when HEAD never moved
  // off base, which is both the common case and trivially a null delta.
  const headMovedFromBase = baseGitSha !== "" && headSha !== baseGitSha;
  let diffBaseSha = baseGitSha;
  if (headMovedFromBase) {
    try {
      diffBaseSha = await git(worktree, ["merge-base", baseGitSha, "HEAD"]);
    } catch {
      diffBaseSha = baseGitSha;
    }
  }
  result.committed = headMovedFromBase
    ? parseShortstat(await git(worktree, ["diff", "--shortstat", diffBaseSha, headSha]))
    : null;
  result.uncommitted = parseShortstat(await git(worktree, ["diff", "--shortstat", headSha, commitSha]));

  if (boundary !== "step") {
    // Branch label + honest diff base — surfaced in the inbox / row feed,
    // not needed per-step.
    let headRef: string | null = null;
    try {
      headRef = (await git(worktree, ["symbolic-ref", "--short", "HEAD"])) || null;
    } catch {
      headRef = null; // detached / tag / unborn
    }
    result.headRef = headRef;
    result.diffBaseSha = diffBaseSha;
  }

  return result;
}
