// Tree capture shared by every fragua capture of a checkout's index + working
// tree: the snapshotter, the CLI's `--dirty` enqueue, and (next) the checkout
// provisioner. A capture writes only a throwaway sentinel index and the object
// database — never the real index, HEAD, or a ref.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type { GitExec } from "./run-actions.ts";

const execFileP = promisify(execFile);

/** Snapshot and dirty-base commits are internal fragua machinery, not user
 * authorship — a fixed identity keeps `commit-tree` independent of the ambient
 * `user.name` / `user.email` (absent on fresh CI runners). */
export const SNAPSHOT_IDENT: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "fragua",
  GIT_AUTHOR_EMAIL: "fragua@localhost",
  GIT_COMMITTER_NAME: "fragua",
  GIT_COMMITTER_EMAIL: "fragua@localhost",
};

async function git(cwd: string, args: string[], env?: Readonly<Record<string, string>>): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

export interface CaptureTreeOptions {
  /** The checkout's toplevel. Every path the capture produces is relative to it. */
  dir: string;
  /** Names the sentinel index (`fragua-index-<label>-<nonce>`), so a leftover
   * names its owner — the run id, or `enqueue`. */
  label: string;
  /** Pathspecs excluded from the capture — `fraguaStateExcludes(rel)` when
   * run.cwd's checkout is `dir`, else empty. */
  excludes: readonly string[];
}

/** Capture `dir`'s index + working tree as a tree object and return its sha.
 * Untracked non-ignored files are included, ignored files excluded. The
 * sentinel index is seeded from the real index so skip-worktree, assume-
 * unchanged and sparse entries carry through unchanged (an untouched checkout
 * captures exactly `tree(HEAD)`). Its name is fresh per call, so a capture
 * killed mid-way leaves an inert leftover rather than a lock every later
 * capture would trip on. */
export async function captureTree(opts: CaptureTreeOptions): Promise<string> {
  const { dir, label, excludes } = opts;
  const gitPath = async (name: string): Promise<string> => {
    const p = await git(dir, ["rev-parse", "--git-path", name]);
    return isAbsolute(p) ? p : join(dir, p);
  };
  const index = await gitPath(`fragua-index-${label}-${randomUUID()}`);
  try {
    try {
      await copyFile(await gitPath("index"), index);
    } catch {
      // no real index yet — start from an empty sentinel (full rehash).
    }
    const env = { GIT_INDEX_FILE: index };
    await git(dir, ["add", "-A", "--", ":/", ...excludes], env);
    return await git(dir, ["write-tree"], env);
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

const STATE_DIRS = ["runs", "worktrees", "blobs", "daemon"] as const;

function globEscape(s: string): string {
  return s.replace(/[*?[\\]/g, (c) => `\\${c}`);
}

/** The five pathspecs that keep run.cwd's fragua state out of a capture of its
 * own checkout. `rel` is run.cwd relative to the checkout toplevel ("" when
 * equal). `literal` stops `[`, `*`, `?` in `rel` acting as wildcards; the
 * database entry needs `glob` for its trailing `*`, so `rel` is escaped there. */
export function fraguaStateExcludes(rel: string): string[] {
  const pre = rel === "" ? "" : `${rel}/`;
  const globPre = rel === "" ? "" : `${globEscape(rel)}/`;
  return [
    ...STATE_DIRS.slice(0, 3).map((d) => `:(top,literal,exclude)${pre}.fragua/${d}/`),
    `:(top,glob,exclude)${globPre}.fragua/fragua.db*`,
    `:(top,literal,exclude)${pre}.fragua/daemon/`,
  ];
}

/** True when toplevel-relative `path` lies under one of the state pathspecs of
 * a run.cwd at `rel`. */
export function isFraguaStatePath(path: string, rel: string): boolean {
  const pre = rel === "" ? ".fragua/" : `${rel}/.fragua/`;
  if (!path.startsWith(pre)) return false;
  const rest = path.slice(pre.length);
  if (STATE_DIRS.some((d) => rest.startsWith(`${d}/`))) return true;
  return rest.startsWith("fragua.db") && !rest.includes("/");
}

/** `update-ref` against a shared ref store can race on `packed-refs` /
 * loose-ref locks when many runs write concurrently. Bounded retry. */
export async function updateRefWithRetry(cwd: string, ref: string, sha: string): Promise<void> {
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

export type DiffStat = { filesChanged: number; insertions: number; deletions: number };

/** Parse `git diff --shortstat` output. Empty output (no changes) → null. */
export function parseShortstat(out: string): DiffStat | null {
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

/** The ref that keeps a dirty-base run's synthetic base reachable — the restore
 * source for its accept. Discard never deletes it; gc reclaims it. */
export function dirtyBaseRef(runId: string): string {
  return `refs/fragua/bases/${runId}`;
}

/** Point `refs/fragua/bases/<runId>` at `sha`. Idempotent: the CLI and the
 * provisioner both write it, and a failure whose ref already reads `sha`
 * counts as success. */
export async function pinDirtyBaseRef(cwd: string, runId: string, sha: string): Promise<void> {
  const ref = dirtyBaseRef(runId);
  try {
    await updateRefWithRetry(cwd, ref, sha);
  } catch (err) {
    let current = "";
    try {
      current = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      current = "";
    }
    if (current !== sha) throw err;
  }
}

/** Why a capture of a checkout is refused before anything is written. Shared
 * with the checkout mode, which adds its own codes. */
export type CaptureRefusal = "not_git" | "unborn_head" | "ignore_block_missing";

const IGNORE_PROBES = [
  ".fragua/runs/x",
  ".fragua/worktrees/x",
  ".fragua/blobs/x",
  ".fragua/fragua.db",
  ".fragua/daemon/x",
] as const;

/** Check that checkout `top` ignores run.cwd's whole fragua state block (the
 * block `fragua init` writes). Returns the state entries that are not ignored. */
export async function checkIgnoreBlock(
  gitExec: GitExec,
  top: string,
  rel: string,
): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  const pre = rel === "" ? "" : `${rel}/`;
  const probes = IGNORE_PROBES.map((p) => `${pre}${p}`);
  const r = await gitExec(top, ["check-ignore", "-z", "--stdin", "--no-index"], { stdin: `${probes.join("\0")}\0` });
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    return { ok: false, missing: probes.map((p) => p.replace(/\/x$/, "/")) };
  }
  const ignored = new Set(r.stdout.split("\0").filter((s) => s !== ""));
  const missing = probes.filter((p) => !ignored.has(p)).map((p) => (p.endsWith("/x") ? p.slice(0, -1) : `${p}*`));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export type DirtyBaseResult =
  | { ok: true; clean: true; headSha: string; baseGitRef: string | null; top: string }
  | { ok: true; clean: false; baseGitSha: string; baseHeadSha: string; baseGitRef: string | null; top: string }
  | { ok: false; reason: CaptureRefusal; detail: string };

/** Capture the operator's uncommitted state in `cwd`'s checkout as a dirty
 * base. A clean tree degenerates to a plain HEAD base; otherwise the synthetic
 * commit S = `commit-tree T -p HEAD` is created (unreferenced — the caller pins
 * `refs/fragua/bases/<runId>` once the run id exists). Refusals write nothing. */
export async function prepareDirtyBase(gitExec: GitExec, cwd: string): Promise<DirtyBaseResult> {
  const topR = await gitExec(cwd, ["rev-parse", "--show-toplevel"]);
  const rawTop = topR.stdout.trim();
  if (topR.exitCode !== 0 || rawTop === "") {
    return { ok: false, reason: "not_git", detail: `--dirty needs a git checkout: ${cwd} is not inside one` };
  }
  const top = realpathSync.native(rawTop);
  const rel = relative(top, realpathSync.native(cwd));

  const headR = await gitExec(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headR.stdout.trim();
  if (headR.exitCode !== 0 || head === "") {
    return {
      ok: false,
      reason: "unborn_head",
      detail: `--dirty needs a commit to capture over: ${top} has no commits yet`,
    };
  }

  const block = await checkIgnoreBlock(gitExec, top, rel);
  if (!block.ok) {
    return {
      ok: false,
      reason: "ignore_block_missing",
      detail: `--dirty needs ${top} to ignore fragua's state (${block.missing.join(", ")}): run \`fragua init\` to write the ignore block`,
    };
  }

  const refR = await gitExec(top, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const baseGitRef = refR.exitCode === 0 && refR.stdout.trim() !== "" ? refR.stdout.trim() : null;

  const tree = await captureTree({ dir: top, label: "enqueue", excludes: fraguaStateExcludes(rel) });
  const headTree = await git(top, ["rev-parse", `${head}^{tree}`]);
  if (tree === headTree) return { ok: true, clean: true, headSha: head, baseGitRef, top };

  const s = await git(top, ["commit-tree", tree, "-p", head, "-m", "fragua dirty base"], SNAPSHOT_IDENT);
  return { ok: true, clean: false, baseGitSha: s, baseHeadSha: head, baseGitRef, top };
}
