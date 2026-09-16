// Resolve a `fragua run --base <ref>` argument to a concrete commit sha at
// enqueue, so the run pins a base independent of the cwd's live HEAD. The
// resolution runs in the same store-client process that mints the run, against
// the project root the run records as its cwd.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type BaseRefResolution = { ok: true; sha: string; ref: string } | { ok: false; error: string };

/** `git -C <cwd> rev-parse --verify <ref>^{commit}` — resolve a branch, tag, or
 * sha to a 40-char commit sha. Returns the resolved sha plus the ref as typed
 * (the human label stored on `run_state.base_git_ref`). A ref that doesn't
 * resolve (or a non-git cwd) yields `{ ok: false }` with a clear message so the
 * caller can refuse the enqueue. */
export async function resolveBaseRef(cwd: string, ref: string): Promise<BaseRefResolution> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = stdout.trim();
    if (sha === "") return { ok: false, error: `--base ${ref} did not resolve to a commit` };
    return { ok: true, sha, ref };
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : (err as Error).message;
    return { ok: false, error: `--base ${ref} is not a valid ref in ${cwd}: ${detail}` };
  }
}
