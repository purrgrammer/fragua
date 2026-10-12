// Checkout runs (`fragua run --checkout <path>`): a run that executes inside an
// existing operator checkout of the same repository instead of a fresh per-run
// worktree. This module names the checkout (its key), decides whether a path
// may host a run, and owns the operator-facing refusal text shared by the CLI,
// the server and the provisioner. It never writes the checkout.
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { checkIgnoreBlock } from "./capture.ts";
import type { GitExec } from "./run-actions.ts";

/** Why a path cannot host a checkout run. The first four are the fixed codes
 * the provisioner halts with at attach (`worktree_error`); `ignore_block_missing`
 * is an enqueue-only check. */
export type CheckoutRefusal =
  | "checkout_missing"
  | "checkout_unregistered"
  | "checkout_fragua_owned"
  | "checkout_unborn"
  | "ignore_block_missing";

export type CheckoutInspection =
  | {
      ok: true;
      /** The checkout key: `realpathSync.native` of its toplevel. */
      key: string;
      /** run.cwd relative to `key` when run.cwd lies inside this checkout
       * (`""` when equal), else `null` — run.cwd's fragua state is then not
       * inside any capture of the checkout. */
      rel: string | null;
      /** HEAD commit sha. */
      head: string;
      /** The checkout's branch, or `null` when HEAD is detached. */
      ref: string | null;
    }
  | { ok: false; reason: CheckoutRefusal; detail: string };

export interface InspectCheckoutOptions {
  /** The operator's path — any directory inside the checkout. */
  path: string;
  /** The run's project root (run.cwd). */
  runCwd: string;
  /** Check the fragua ignore block (enqueue only; never re-checked at attach). */
  checkIgnore: boolean;
  /** True when `key` is some non-imported run's own fragua worktree
   * (`<r.cwd>/.fragua/worktrees/<r.run_id>`, realpathed) — the store lookup
   * the CLI supplies on top of the directory-shape marker. */
  isRunWorktree?: (key: string) => boolean;
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The checkout key for any directory inside a checkout, or `null` when `dir`
 * is not inside a git checkout. */
export async function resolveCheckoutKey(git: GitExec, dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  const top = r.stdout.trim();
  if (r.exitCode !== 0 || top === "") return null;
  return canonical(top);
}

/** The directory shape `fragua gc --worktrees` matches: `<…>/.fragua/worktrees/<id>`. */
export function isFraguaOwnedWorktreePath(key: string): boolean {
  const parent = dirname(key);
  return basename(parent) === "worktrees" && basename(dirname(parent)) === ".fragua";
}

async function commonDir(git: GitExec, dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const p = r.stdout.trim();
  if (r.exitCode !== 0 || p === "") return null;
  return canonical(isAbsolute(p) ? p : join(dir, p));
}

/** Realpaths of every worktree git has registered for the repository at `dir`
 * (the main checkout included). */
export async function listWorktreeRealpaths(git: GitExec, dir: string): Promise<Set<string>> {
  const r = await git(dir, ["worktree", "list", "--porcelain"]);
  const out = new Set<string>();
  if (r.exitCode !== 0) return out;
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    out.add(canonical(line.slice("worktree ".length).trim()));
  }
  return out;
}

/** Decide whether `path` may host a checkout run of the repository at
 * `runCwd`: it must exist, belong to the same repository (same
 * `--git-common-dir`, registered), not be a fragua-owned worktree, have a born
 * HEAD and — at enqueue — ignore the fragua state block. Read-only. */
export async function inspectCheckout(git: GitExec, opts: InspectCheckoutOptions): Promise<CheckoutInspection> {
  try {
    await access(opts.path);
  } catch {
    return { ok: false, reason: "checkout_missing", detail: `checkout ${opts.path} does not exist` };
  }
  const key = await resolveCheckoutKey(git, opts.path);
  if (key == null) {
    return { ok: false, reason: "checkout_unregistered", detail: `${opts.path} is not inside a git checkout` };
  }
  const [mine, theirs] = await Promise.all([commonDir(git, key), commonDir(git, opts.runCwd)]);
  if (mine == null || theirs == null || mine !== theirs) {
    return {
      ok: false,
      reason: "checkout_unregistered",
      detail: `checkout ${key} is not a checkout of the repository at ${opts.runCwd}`,
    };
  }
  if (!(await listWorktreeRealpaths(git, opts.runCwd)).has(key)) {
    return {
      ok: false,
      reason: "checkout_unregistered",
      detail: `checkout ${key} is not a registered worktree of the repository (see \`git worktree list\`)`,
    };
  }
  if (isFraguaOwnedWorktreePath(key) || opts.isRunWorktree?.(key) === true) {
    return {
      ok: false,
      reason: "checkout_fragua_owned",
      detail: `${key} is a fragua-owned run worktree; name a checkout you own`,
    };
  }
  const headR = await git(key, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headR.stdout.trim();
  if (headR.exitCode !== 0 || head === "") {
    return { ok: false, reason: "checkout_unborn", detail: `checkout ${key} has no commits yet` };
  }
  const runReal = canonical(opts.runCwd);
  const relToKey = relative(key, runReal);
  const inside = relToKey === "" || (!relToKey.startsWith("..") && !isAbsolute(relToKey));
  const rel = inside ? relToKey.split(sep).join("/") : null;
  if (opts.checkIgnore) {
    // For a checkout other than run.cwd's own, probe where the project's
    // `.fragua/` would sit in it (run.cwd's offset inside its own checkout).
    const runTop = rel == null ? await resolveCheckoutKey(git, opts.runCwd) : null;
    const blockRel = rel ?? (runTop != null ? relative(runTop, runReal).split(sep).join("/") : "");
    const block = await checkIgnoreBlock(git, key, blockRel);
    if (!block.ok) {
      return {
        ok: false,
        reason: "ignore_block_missing",
        detail: `--checkout needs ${key} to ignore fragua's state (${block.missing.join(", ")}): run \`fragua init\` to write the ignore block`,
      };
    }
  }
  const refR = await git(key, ["symbolic-ref", "--short", "--quiet", "HEAD"]);
  const ref = refR.exitCode === 0 && refR.stdout.trim() !== "" ? refR.stdout.trim() : null;
  return { ok: true, key, rel, head, ref };
}

/** The `checkout_busy` refusal — identical on the CLI and the web. */
export function checkoutBusyDetail(path: string, runId: string, status: string): string {
  return `checkout ${path} is held by run ${runId} (${status}); wait for it to finish, or run \`fragua runs release ${runId}\` once it is terminal`;
}

/** The accept/discard refusal for a checkout run: its work is already in the
 * checkout, so there is nothing to land — commit it or restore the base. */
export function checkoutNotInInboxDetail(path: string | null, baseGitSha: string): string {
  return `run executed in checkout ${path ?? "(unbound)"}; its changes are already there — commit them or restore with \`git restore --source=${baseGitSha} --worktree -- :/\``;
}
