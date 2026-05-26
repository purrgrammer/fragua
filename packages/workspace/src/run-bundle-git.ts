// Git-bundle transport for a run's tree state (db-import.md §3.2), alongside the
// other `refs/fragua/*` plumbing in run-actions.ts. `buildRunGitBundle` packages
// a run's snapshot / head / base commits into a self-contained git-bundle;
// `rehydrateRunWorktree` fetches those objects into a host repo and checks out
// the snapshot tip as the run's per-run worktree. Both shell git via the
// injected GitExec (the store can't) — used by `runs export`, `ci --export`,
// and `runs import --rehydrate`.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitExec } from "./run-actions.ts";

/** A self-contained git-bundle of a run's tree state (snapshot + head + base
 *  commits), or `null` when the run has none — a bare-cwd run, or the repo /
 *  refs are gone. Best-effort: a missing snapshots ref means no tree state. */
export async function buildRunGitBundle(
  git: GitExec,
  cwd: string,
  runId: string,
  baseGitSha: string | null,
  diffBaseSha: string | null,
): Promise<Uint8Array | null> {
  const snapRef = `refs/fragua/snapshots/${runId}`;
  const candidates = [
    snapRef,
    `refs/fragua/heads/${runId}`,
    ...(baseGitSha != null && baseGitSha !== "" ? [baseGitSha] : []),
    ...(diffBaseSha != null && diffBaseSha !== "" && diffBaseSha !== baseGitSha ? [diffBaseSha] : []),
  ];
  const revs: string[] = [];
  for (const c of candidates) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", c]);
    if (r.exitCode === 0 && r.stdout.trim() !== "") revs.push(c);
  }
  if (!revs.includes(snapRef)) return null; // no snapshots → no tree state

  const tmp = join(tmpdir(), `fragua-export-${runId}-${process.pid}.gitbundle`);
  try {
    const r = await git(cwd, ["bundle", "create", tmp, ...revs]);
    if (r.exitCode !== 0) return null;
    return new Uint8Array(readFileSync(tmp));
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type RehydrateResult = { ok: true; worktree: string } | { ok: false; error: string };

/** Unbundle a run's tree state into `host` (an existing git repo) and check out
 *  the snapshot tip as `<host>/.fragua/worktrees/<runId>` — the same per-run
 *  worktree path the executor's provisioner reuses. Recreates the `refs/fragua/*`
 *  refs via `git fetch`. The caller is responsible for rebinding the run's cwd. */
export async function rehydrateRunWorktree(
  git: GitExec,
  host: string,
  runId: string,
  bundleBytes: Uint8Array,
): Promise<RehydrateResult> {
  const tmp = join(tmpdir(), `fragua-rehydrate-${runId}-${process.pid}.gitbundle`);
  try {
    writeFileSync(tmp, bundleBytes);
    const fetched = await git(host, ["fetch", tmp, "+refs/fragua/*:refs/fragua/*"]);
    if (fetched.exitCode !== 0) return { ok: false, error: `git fetch (unbundle) failed: ${fetched.stderr.trim()}` };
  } finally {
    rmSync(tmp, { force: true });
  }
  const worktree = join(host, ".fragua/worktrees", runId);
  const added = await git(host, ["worktree", "add", "--detach", worktree, `refs/fragua/snapshots/${runId}`]);
  if (added.exitCode !== 0) return { ok: false, error: `git worktree add failed: ${added.stderr.trim()}` };
  return { ok: true, worktree };
}
