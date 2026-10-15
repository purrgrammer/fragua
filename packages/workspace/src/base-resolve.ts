// Read-only resolution of the base a `fragua run` executes against, done at
// enqueue so the operator sees (and the run records) the exact commit before
// the daemon provisions anything.
import type { GitExec } from "./run-actions.ts";

export type HeadBaseResolution =
  | { ok: true; sha: string; ref: string | null }
  | { ok: false; reason: "not_git" | "unborn_head" };

/** HEAD of `cwd`'s checkout: its commit sha and branch short name (`null` when
 * detached). The same reads the provisioner makes when no base is recorded. */
export async function resolveHeadBase(git: GitExec, cwd: string): Promise<HeadBaseResolution> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { ok: false, reason: "not_git" };
  const head = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const sha = head.stdout.trim();
  if (head.exitCode !== 0 || sha === "") return { ok: false, reason: "unborn_head" };
  return { ok: true, sha, ref: await currentBranch(git, cwd) };
}

/** Branch short name `cwd`'s checkout is on, or `null` when detached / not git. */
export async function currentBranch(git: GitExec, cwd: string): Promise<string | null> {
  const r = await git(cwd, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const ref = r.stdout.trim();
  return r.exitCode === 0 && ref !== "" ? ref : null;
}

/** The project's default branch: `origin/HEAD`'s target, else a local `main`,
 * else a local `master`, else `null`. */
export async function resolveDefaultBranch(git: GitExec, cwd: string): Promise<string | null> {
  const origin = await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const target = origin.stdout.trim();
  if (origin.exitCode === 0 && target.startsWith("refs/remotes/origin/")) {
    const name = target.slice("refs/remotes/origin/".length);
    if (name !== "") return name;
  }
  for (const name of ["main", "master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (r.exitCode === 0 && r.stdout.trim() !== "") return name;
  }
  return null;
}

/** Number of paths that differ between two commits. */
export async function countChangedFiles(git: GitExec, cwd: string, from: string, to: string): Promise<number> {
  const r = await git(cwd, ["diff", "--name-only", "-z", from, to]);
  if (r.exitCode !== 0) return 0;
  return r.stdout.split("\0").filter((p) => p !== "").length;
}
