// Git-bundle transport for a run's tree state (db-import.md §3.2), alongside the
// other `refs/fragua/*` plumbing in run-actions.ts. `buildRunGitBundle` packages
// a run's snapshot / head / base commits into a self-contained git-bundle;
// `rehydrateRunWorktree` fetches those objects into a host repo and provisions
// the snapshot tip as the run's per-run worktree through the same
// `WorktreeEnvironment` a native run uses — so bootstrap runs identically. Used
// by `runs export`, `ci --export`, and `runs import --rehydrate`.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitExec } from "./run-actions.ts";
import { type BootstrapSpec, WorktreeEnvironment } from "./worktree-env.ts";

// A run id flows into tmpfile paths, the worktree dir, and refspecs below. The
// store validates it on import, but these functions are also reached directly
// (export / ci --export) and on rehydrate carry a bundle-supplied id — so guard
// at the fs/ref boundary too. Mirrors `assertSafeRunId` in @fragua/store.
const RUN_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/; // 26-char lowercased Crockford ULID

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
  if (!RUN_ID_RE.test(runId)) throw new Error(`buildRunGitBundle: unsafe run id ${JSON.stringify(runId)}`);
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

/** Optional bootstrap for a rehydrated worktree, resolved by the caller from
 *  the host project's config. Ignored deps (node_modules, build output) don't
 *  travel in the bundle — git snapshots respect `.gitignore` — so a rehydrated
 *  worktree must regenerate them exactly as a fresh run's provisioning does. */
export interface RehydrateOptions {
  bootstrap?: BootstrapSpec;
  bootstrapTimeoutMs?: number;
  defaultTimeoutMs?: number;
}

export type RehydrateResult = { ok: true; worktree: string; bootstrapRan: boolean } | { ok: false; error: string };

/** Unbundle a run's tree state into `host` (an existing git repo) and provision
 *  the snapshot tip as `<host>/.fragua/worktrees/<runId>` — through the SAME
 *  `WorktreeEnvironment` a native run uses, so bootstrap runs identically (a
 *  rehydrated worktree regenerates ignored deps that the bundle couldn't carry).
 *  Recreates the `refs/fragua/*` refs via `git fetch`. The caller rebinds the
 *  run's cwd. */
export async function rehydrateRunWorktree(
  git: GitExec,
  host: string,
  runId: string,
  bundleBytes: Uint8Array,
  opts: RehydrateOptions = {},
): Promise<RehydrateResult> {
  if (!RUN_ID_RE.test(runId)) return { ok: false, error: `unsafe run id ${JSON.stringify(runId)}` };
  const tmp = join(tmpdir(), `fragua-rehydrate-${runId}-${process.pid}.gitbundle`);
  try {
    writeFileSync(tmp, bundleBytes);
    const fetched = await git(host, ["fetch", tmp, "+refs/fragua/*:refs/fragua/*"]);
    if (fetched.exitCode !== 0) return { ok: false, error: `git fetch (unbundle) failed: ${fetched.stderr.trim()}` };
  } finally {
    rmSync(tmp, { force: true });
  }

  const env = new WorktreeEnvironment({
    runId,
    repoRoot: host,
    baseRef: `refs/fragua/snapshots/${runId}`,
    ...(opts.bootstrap !== undefined ? { bootstrap: opts.bootstrap } : {}),
    ...(opts.bootstrapTimeoutMs !== undefined ? { bootstrapTimeoutMs: opts.bootstrapTimeoutMs } : {}),
    ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
  });
  try {
    await env.init();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, worktree: env.worktreePath, bootstrapRan: env.bootstrapRan };
}
