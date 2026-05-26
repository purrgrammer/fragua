// Build a run's tree state into a git-bundle for export (db-import §3.2).
// Shared by `runs export` and `ci --export`: both shell git (the store can't),
// so the bundle bytes are produced here and handed to store.exportRunBundle as
// the `gitBundle` option.

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitExec } from "@fragua/workspace";

/** A self-contained git-bundle of a run's tree state (snapshot + head + base
 *  commits), or `null` when the run has none — a bare-cwd run, or the repo /
 *  refs are gone. Best-effort: a missing snapshots ref means rows-only export. */
export async function buildGitBundle(
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
    ...(baseGitSha != null ? [baseGitSha] : []),
    ...(diffBaseSha != null && diffBaseSha !== baseGitSha ? [diffBaseSha] : []),
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
