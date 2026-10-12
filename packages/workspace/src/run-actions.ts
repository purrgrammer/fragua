// Synchronous post-terminal operator actions on a run's worktree refs.
//
// `accept` lands a terminal run's work on the operator's current branch and
// `discard` drops it — both pure git plumbing over `refs/fragua/{snapshots,
// heads}/<runId>`, callable inline from the server route and the CLI (no daemon
// sweep). `accept` is the validated replay+stage algorithm
// probe the whole run merge in
// memory first, then replay the workflow's commits onto HEAD and stage the
// uncommitted tail for the operator to commit. Nothing fragua-authored enters
// history — replayed commits keep their own message/author; the tail is the
// operator's commit.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, readlink, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { type InboxStatus, isTerminal, type RunStatus } from "@fragua/types";
import { type DiffStat, dirtyBaseRef, isFraguaStatePath, parseShortstat } from "./capture.ts";
import { checkoutBusyDetail, checkoutNotInInboxDetail } from "./checkout.ts";

const execFileP = promisify(execFile);

/** Run git in `cwd`. `stdin` feeds the process (used to pipe a patch into
 * `git apply`). Never throws on a non-zero exit — returns the code. */
export type GitExec = (
  cwd: string,
  args: string[],
  opts?: { stdin?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const defaultGitExec: GitExec = async (cwd, args, opts) => {
  try {
    const child = execFileP("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
    if (opts?.stdin !== undefined) {
      child.child.stdin?.end(opts.stdin);
    }
    const { stdout, stderr } = await child;
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : String(e.stdout ?? ""),
      stderr: typeof e.stderr === "string" ? e.stderr : String(e.stderr ?? ""),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

async function revParse(git: GitExec, cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", rev]);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && sha !== "" ? sha : null;
}

async function mustGit(git: GitExec, cwd: string, args: string[], stdin?: string): Promise<string> {
  const r = await git(cwd, args, stdin === undefined ? undefined : { stdin });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

/** State preconditions an operator action needs, read from `run_state` by the
 * adapter and folded into the action so the adapter holds no gate of its own
 * (intent-plane.md §3.7). The action returns every refusal — state and git —
 * in one discriminated result. */
export interface RunActionGate {
  runId: string;
  status: RunStatus;
  inboxStatus: InboxStatus | null;
  cwd: string | null;
  baseGitSha: string;
  /** `run_state.base_head_sha` — non-null marks a dirty-base run, which accept
   * lands as unstaged working-tree changes instead of replaying commits. */
  baseHeadSha: string | null;
  /** `run_state.diff_base_sha` — the range the review surfaces showed. */
  diffBaseSha: string | null;
  /** `run_state.in_checkout` — the run executed in an operator checkout, so
   * there is nothing held aside to land or drop. */
  inCheckout: boolean;
  /** `run_state.checkout_path` — used only for the refusal message. */
  checkoutPath: string | null;
  /** Precomputed by the gate builder: the run holding run.cwd's checkout, or
   * `null` when free. Accept-only — every accept writes that checkout;
   * discard deletes refs only and ignores it. */
  checkoutBusy: { runId: string; status: string; path: string } | null;
}

/** Refusals from the state gate, shared by accept and discard. */
export type RunActionRefusal = "not_terminal" | "not_in_inbox" | "discarded" | "no_worktree";

/** Check the gate; on success narrow `cwd` to non-null for the git step. */
function checkGate(
  gate: RunActionGate,
): { ok: true; cwd: string } | { ok: false; reason: RunActionRefusal; detail: string } {
  if (!isTerminal(gate.status)) {
    return { ok: false, reason: "not_terminal", detail: `run not terminal (status=${gate.status})` };
  }
  if (gate.inCheckout) {
    return { ok: false, reason: "not_in_inbox", detail: checkoutNotInInboxDetail(gate.checkoutPath, gate.baseGitSha) };
  }
  if (gate.inboxStatus == null) return { ok: false, reason: "not_in_inbox", detail: "run has no recoverable work" };
  if (gate.inboxStatus === "discarded") return { ok: false, reason: "discarded", detail: "run already discarded" };
  if (gate.cwd == null) return { ok: false, reason: "no_worktree", detail: "run has no worktree (bare-cwd)" };
  return { ok: true, cwd: gate.cwd };
}

/** After staging a tree into the index, drop any worktree paths that the index
 * deletes relative to HEAD. `read-tree`+`checkout-index` and, for some rename
 * shapes, `apply --index` update the index for a deleted/renamed source without
 * unlinking its old worktree file, leaving it as an untracked copy that later
 * blocks `git checkout`. `--no-renames` forces rename sources to surface as
 * plain deletions so their old paths are removed too.
 *
 * A non-zero exit from the delete-listing diff (corrupt index, wrong cwd) is
 * propagated rather than swallowed: leaving stale worktree files silently would
 * let `accept` report success on a possibly inconsistent tree. */
async function pruneDeletedWorktreePaths(git: GitExec, cwd: string): Promise<void> {
  // Index paths are relative to the repo toplevel, but `cwd` is the run's
  // project root, which may sit in a subdirectory of it (the project root is
  // the nearest `.fragua/config.yaml`, only *bounded* by the git root). Joining
  // against `cwd` there would miss the real files and unlink unrelated ones.
  const top = await mustGit(git, cwd, ["rev-parse", "--show-toplevel"]);
  // Not `mustGit`: it trims, and a NUL-separated listing whose first entry
  // begins with whitespace would lose that leading space and name a different,
  // undeleted file.
  const r = await git(cwd, ["diff", "--cached", "--no-renames", "--diff-filter=D", "--name-only", "-z"]);
  if (r.exitCode !== 0) {
    throw new Error(`git diff --cached --diff-filter=D failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  // Sequential, not `Promise.all`: a rejecting `rm` there leaves siblings in
  // flight, and the caller's `reset --hard` could restore a path a straggler
  // then unlinks.
  for (const path of r.stdout.split("\0")) {
    if (path === "") continue;
    await rm(join(top, path), { force: true });
  }
}

/** Run the post-stage prune and, on failure, roll the index+worktree back to
 * `target` — mirroring the cherry-pick / apply conflict paths so a prune fault
 * leaves the operator's tree as clean as any other refusal. Returns a refusal
 * `AcceptResult` on failure, or `null` when the prune succeeded. */
async function pruneOrRollback(git: GitExec, cwd: string, target: string): Promise<AcceptResult | null> {
  try {
    await pruneDeletedWorktreePaths(git, cwd);
    return null;
  } catch (err) {
    await git(cwd, ["reset", "--hard", target]);
    return {
      ok: false,
      reason: "conflict",
      detail: `prune failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** What a dirty-base land wrote — enough for the caller to print the undo.
 * Paths are relative to `top`, the checkout toplevel. */
export interface DirtyLand {
  top: string;
  /** S — the synthetic base, the pre-accept content of every path in D. */
  baseSha: string;
  /** P — the run's terminal snapshot. */
  snapSha: string;
  /** Paths in D that S holds: `git restore --source=S --worktree` undoes them. */
  restorable: string[];
  /** Paths the land created (absent from S): undo deletes them. */
  created: string[];
  stat: DiffStat;
}

/** Refusals of the dirty-base accept, shared with the checkout mode. */
export type DirtyAcceptRefusal = "relocated_base" | "checkout_moved" | "checkout_unsafe_path";

export type AcceptResult =
  | {
      ok: true;
      sha: string;
      replayed: number;
      tailStaged: boolean;
      stashPopConflict?: boolean;
      landedUnstaged?: true;
      land?: DirtyLand;
    }
  | {
      ok: false;
      reason: RunActionRefusal | "no_work" | "dirty_tree" | "conflict" | "checkout_busy" | DirtyAcceptRefusal;
      detail: string;
    };

/** Knobs on the accept action. `autostash` mirrors `git rebase --autostash`:
 * stash the operator's unrelated working-tree changes before the apply and
 * restore them after — so a tree dirty only in files the run doesn't touch no
 * longer refuses with `dirty_tree`. Off by default (behavior unchanged). */
export interface AcceptActionOptions {
  autostash?: boolean;
}

/**
 * Land a terminal run's work on the operator's current branch (HEAD in `cwd`).
 * Replays the workflow's commits (`baseGitSha..heads`) preserving message +
 * author, then stages the uncommitted tail (the dirt that sat on top) for the
 * operator to commit. A conflict — detected up front by an in-memory
 * `merge-tree` of the whole run, or by the cherry-pick / tail-apply — leaves
 * the operator's branch and working tree untouched and returns
 * `{ ok:false, reason:"conflict" }` (resolve via revive).
 *
 * When the run's base is NOT an ancestor of HEAD (e.g. the branch the run
 * forked from was squash-merged), the merge-tree probe's auto merge-base
 * falls back to an older fork point and re-merges changes HEAD already has,
 * reporting spurious conflicts. In that case the probe is skipped and the
 * base..tip change is applied 3-way directly — commits replayed in order via
 * cherry-pick (each against its own parent), the tail via `apply --3way`
 * against the snapshot's base blobs. A genuine textual conflict still rolls
 * back and refuses with `conflict`.
 *
 * With `options.autostash`, the operator's unrelated working-tree changes are
 * stashed (`git stash push --include-untracked`) before the apply and popped
 * after — on success AND on a refusal, so the stash is always restored. If the
 * pop itself conflicts with the just-landed change the stash is left intact
 * (not dropped) and the success result carries `stashPopConflict:true`.
 */
export async function applyAccept(
  git: GitExec,
  gate: RunActionGate,
  options?: AcceptActionOptions,
): Promise<AcceptResult> {
  const g = checkGate(gate);
  if (!g.ok) return g;
  const cwd = g.cwd;
  const busy = gate.checkoutBusy;
  if (busy != null) {
    return { ok: false, reason: "checkout_busy", detail: checkoutBusyDetail(busy.path, busy.runId, busy.status) };
  }
  // A dirty-base run's dirt is its base: it lands per path and never needs the
  // tree clean, so autostash does not apply.
  if (gate.baseHeadSha != null) return acceptDirtyBase(git, gate, cwd);
  if (options?.autostash !== true) return acceptInner(git, gate, cwd);

  // Autostash: park unrelated dirt so the clean-tree gate doesn't refuse, then
  // restore it whatever the outcome. `stash push` is a no-op (exit 0, no new
  // stash) on a clean tree, so compare refs/stash to know if we actually saved.
  const before = await revParse(git, cwd, "refs/stash");
  await git(cwd, ["stash", "push", "--include-untracked", "--quiet"]);
  const after = await revParse(git, cwd, "refs/stash");
  const stashed = after != null && after !== before;

  const result = await acceptInner(git, gate, cwd);
  if (!stashed) return result;

  const pop = await git(cwd, ["stash", "pop"]);
  if (pop.exitCode !== 0 && result.ok) {
    // The pop collides with the change we just landed. Don't drop the stash —
    // the operator's work would be lost. Leave it on the stack and flag it.
    return { ...result, stashPopConflict: true };
  }
  return result;
}

async function acceptInner(git: GitExec, gate: RunActionGate, cwd: string): Promise<AcceptResult> {
  const { runId, baseGitSha } = gate;
  const snapRef = `refs/fragua/snapshots/${runId}`;

  const snapCommit = await revParse(git, cwd, snapRef);
  if (snapCommit == null) return { ok: false, reason: "no_work", detail: `no ${snapRef}` };
  const snapTree = await revParse(git, cwd, `${snapRef}^{tree}`);
  const runHead = (await revParse(git, cwd, `refs/fragua/heads/${runId}`)) ?? baseGitSha;
  const runTree = await revParse(git, cwd, `${runHead}^{tree}`);
  const target = await revParse(git, cwd, "HEAD");
  if (snapTree == null || runTree == null || target == null) {
    return { ok: false, reason: "no_work", detail: "could not resolve run/target trees" };
  }

  // Precondition: clean target. `accept` advances HEAD and stages the tail; a
  // dirty checkout would be clobbered, so refuse rather than risk local work.
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status.stdout.trim() !== "") {
    return { ok: false, reason: "dirty_tree", detail: "operator working tree is not clean" };
  }

  // The probe below is only sound when the run's base is in HEAD's ancestry:
  // merge-tree's auto merge-base must resolve to the run's base, not an older
  // fork point (squash-merges break this and yield false conflicts).
  const baseIsAncestor = (await git(cwd, ["merge-base", "--is-ancestor", baseGitSha, target])).exitCode === 0;

  if (baseIsAncestor) {
    // Pre-probe: 3-way merge of the WHOLE run (commits + dirt) onto HEAD, in
    // memory, no mutation. auto-base = merge-base(HEAD, snapCommit) = the run's
    // base, so this single probe predicts both the replay and the tail.
    const probe = await git(cwd, ["merge-tree", "--write-tree", target, snapCommit]);
    if (probe.exitCode !== 0) {
      return { ok: false, reason: "conflict", detail: "run does not merge cleanly onto HEAD" };
    }

    // Dirt-only run (no workflow commits): stage the merged tree the probe
    // already produced — no cherry-pick needed.
    if (runHead === baseGitSha) {
      const mergedTree = probe.stdout.trim().split("\n", 1)[0] ?? "";
      await mustGit(git, cwd, ["read-tree", mergedTree]);
      await mustGit(git, cwd, ["checkout-index", "-a", "-f"]);
      const pruned = await pruneOrRollback(git, cwd, target);
      if (pruned != null) return pruned;
      return { ok: true, sha: target, replayed: 0, tailStaged: snapTree !== runTree };
    }
  } else if (runHead === baseGitSha) {
    // Dirt-only run across a broken ancestry: 3-way apply of the base..snap
    // delta — the snapshot keeps the base blobs, so resolution works even
    // though the base commit is not in HEAD's history.
    const patch = await git(cwd, ["diff", "--full-index", "--binary", runTree, snapTree]);
    const apply = await git(cwd, ["apply", "--3way", "--index"], { stdin: patch.stdout });
    if (apply.exitCode !== 0) {
      await git(cwd, ["reset", "--hard", target]);
      return { ok: false, reason: "conflict", detail: "run does not apply onto HEAD (3-way across squashed base)" };
    }
    const pruned = await pruneOrRollback(git, cwd, target);
    if (pruned != null) return pruned;
    return { ok: true, sha: target, replayed: 0, tailStaged: snapTree !== runTree };
  }

  // Replay the workflow's commits onto HEAD (message + author preserved).
  const cp = await git(cwd, ["cherry-pick", `${baseGitSha}..${runHead}`]);
  if (cp.exitCode !== 0) {
    await git(cwd, ["cherry-pick", "--abort"]);
    await git(cwd, ["reset", "--hard", target]);
    return { ok: false, reason: "conflict", detail: "cherry-pick conflict during replay" };
  }
  const replayed = Number(await mustGit(git, cwd, ["rev-list", "--count", `${target}..HEAD`]));
  const replayedTip = await revParse(git, cwd, "HEAD");

  // Stage the uncommitted tail (dirt that sat on top of runHead) on top of the
  // replayed tip, for the operator to commit.
  let tailStaged = false;
  if (snapTree !== runTree) {
    const patch = await git(cwd, ["diff", "--full-index", "--binary", runTree, snapTree]);
    const apply = await git(cwd, ["apply", "--3way", "--index"], { stdin: patch.stdout });
    if (apply.exitCode !== 0) {
      await git(cwd, ["reset", "--hard", target]);
      return { ok: false, reason: "conflict", detail: "tail does not apply onto the replayed commits" };
    }
    const pruned = await pruneOrRollback(git, cwd, target);
    if (pruned != null) return pruned;
    tailStaged = true;
  }

  return { ok: true, sha: replayedTip ?? target, replayed, tailStaged };
}

type TreeEntry = { mode: string; sha: string } | null;

interface DiffPath {
  path: string;
  s: TreeEntry;
  p: TreeEntry;
}

type DiskState =
  | { kind: "absent" }
  | { kind: "dir" }
  | { kind: "other" }
  | { kind: "entry"; mode: string; sha: string };

const ZERO_MODE = "000000";
const REGULAR_MODES = new Set(["100644", "100755"]);

/** Parse `git diff --raw -z --no-renames` into per-path S/P entries. */
function parseRawDiff(out: string): DiffPath[] {
  const parts = out.split("\0");
  const paths: DiffPath[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    if (!meta.startsWith(":") || path === "") break;
    const [m1, m2, s1, s2] = meta.slice(1).split(" ");
    const entry = (mode: string | undefined, sha: string | undefined): TreeEntry =>
      mode == null || sha == null || mode === ZERO_MODE ? null : { mode, sha };
    paths.push({ path, s: entry(m1, s1), p: entry(m2, s2) });
  }
  return paths;
}

/** A path's on-disk state, read with lstat and git's own hashing — never
 * through ignore rules, so a land cannot change what it compares against. */
async function readDiskState(git: GitExec, top: string, path: string, fileMode: boolean): Promise<DiskState> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(join(top, path));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw err;
  }
  if (st.isDirectory()) return { kind: "dir" };
  if (st.isSymbolicLink()) {
    const target = await readlink(join(top, path));
    const sha = await mustGit(git, top, ["hash-object", "--stdin", "--no-filters"], target);
    return { kind: "entry", mode: "120000", sha };
  }
  if (st.isFile()) {
    const sha = await mustGit(git, top, ["hash-object", "--", path]);
    const mode = fileMode && (st.mode & 0o111) !== 0 ? "100755" : "100644";
    return { kind: "entry", mode, sha };
  }
  return { kind: "other" };
}

/**
 * Land a dirty-base run's effect as unstaged working-tree changes in its
 * checkout, path by path. S = `baseGitSha` (the synthetic base), P = the
 * terminal snapshot, D = the paths S→P changes. Every path in D must still hold
 * its S content; paths outside D are never read or written; HEAD, the branch
 * and the index are untouched. Refusals write nothing.
 */
async function acceptDirtyBase(git: GitExec, gate: RunActionGate, cwd: string): Promise<AcceptResult> {
  const { runId, baseGitSha: s } = gate;
  const baseRef = dirtyBaseRef(runId);
  const snapRef = `refs/fragua/snapshots/${runId}`;
  const p = await revParse(git, cwd, snapRef);
  if (p == null) return { ok: false, reason: "no_work", detail: `no ${snapRef} (restore source: ${baseRef})` };
  const where = `restore source: ${baseRef}; range ${s.slice(0, 7)}→${p.slice(0, 7)}`;

  if (gate.diffBaseSha !== s) {
    return {
      ok: false,
      reason: "relocated_base",
      detail: `the run moved its HEAD off its dirty base, so the reviewed range is not the one accept would land; land by hand from \`git diff ${s} ${p}\` (${where})`,
    };
  }

  const top = await mustGit(git, cwd, ["rev-parse", "--show-toplevel"]);
  const h = await revParse(git, top, "HEAD");
  if (h == null || h !== gate.baseHeadSha) {
    return {
      ok: false,
      reason: "checkout_moved",
      detail: `HEAD is ${h?.slice(0, 7) ?? "unborn"} but the run was captured over ${gate.baseHeadSha?.slice(0, 7)}; check out ${gate.baseHeadSha?.slice(0, 7)} and retry (${where})`,
    };
  }

  const raw = await git(top, ["diff", "--no-renames", "--no-abbrev", "-z", "--raw", s, p]);
  if (raw.exitCode !== 0) {
    return { ok: false, reason: "no_work", detail: `git diff ${s} ${p} failed: ${raw.stderr.trim()} (${where})` };
  }
  const d = parseRawDiff(raw.stdout);

  // Paths the land cannot write safely: a gitlink (removing a deleted
  // submodule would delete a working tree with its own .git), fragua's own
  // state, and `.gitattributes` (it changes how the other paths hash).
  const cwdRel = relative(realpathSync.native(top), realpathSync.native(cwd));
  const rel = cwdRel.startsWith("..") ? null : cwdRel;
  const unsafe = d
    .filter(
      (e) =>
        e.s?.mode === "160000" ||
        e.p?.mode === "160000" ||
        (rel != null && isFraguaStatePath(e.path, rel)) ||
        e.path === ".gitattributes" ||
        e.path.endsWith("/.gitattributes"),
    )
    .map((e) => e.path);
  if (unsafe.length > 0) {
    return {
      ok: false,
      reason: "checkout_unsafe_path",
      detail: `cannot land ${unsafe.join(", ")} (a submodule, fragua state, or .gitattributes); land those by hand (${where})`,
    };
  }

  const fileModeR = await git(top, ["config", "--bool", "core.fileMode"]);
  const fileMode = fileModeR.stdout.trim() !== "false";
  const moved: string[] = [];
  const outside: string[] = [];
  const present = new Set<string>();
  for (const e of d) {
    const disk = await readDiskState(git, top, e.path, fileMode);
    if (disk.kind !== "absent") present.add(e.path);
    let matches: boolean;
    if (e.s == null) {
      matches = disk.kind === "absent" || (disk.kind === "dir" && (await revParse(git, top, `${s}:${e.path}`)) != null);
    } else {
      matches =
        disk.kind === "entry" &&
        disk.sha === e.s.sha &&
        (disk.mode === e.s.mode || (!fileMode && REGULAR_MODES.has(disk.mode) && REGULAR_MODES.has(e.s.mode)));
    }
    if (matches) continue;
    if (e.s == null) outside.push(e.path);
    else moved.push(e.path);
  }
  if (outside.length > 0) {
    return {
      ok: false,
      reason: "checkout_unsafe_path",
      detail: `${outside.join(", ")} ${outside.length === 1 ? "holds" : "hold"} content outside the captured base, which accept could not restore; move ${outside.length === 1 ? "it" : "them"} aside and retry (${where})`,
    };
  }
  if (moved.length > 0) {
    return {
      ok: false,
      reason: "checkout_moved",
      detail: `${moved.join(", ")} changed since the run was captured; restore ${moved.length === 1 ? "it" : "them"} from ${baseRef} or land by hand (${where})`,
    };
  }

  // Removals first, so a path the run turned from a file into a directory (or
  // back) can be written in place.
  const writes = d.filter((e) => e.p != null).map((e) => e.path);
  try {
    for (const e of d) {
      if (e.p != null || !present.has(e.path)) continue;
      await rm(join(top, e.path), { force: true });
      for (let dir = dirname(e.path); dir !== "." && dir !== ""; dir = dirname(dir)) {
        try {
          await rmdir(join(top, dir));
        } catch {
          break;
        }
      }
    }
    if (writes.length > 0) {
      await mustGit(
        git,
        top,
        [
          "--literal-pathspecs",
          "restore",
          `--source=${p}`,
          "--worktree",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        `${writes.join("\0")}\0`,
      );
    }
  } catch (err) {
    return {
      ok: false,
      reason: "conflict",
      detail: `land stopped part-way: ${err instanceof Error ? err.message : String(err)}; restore the paths from ${baseRef} (${where})`,
    };
  }

  const stat = parseShortstat((await git(top, ["diff", "--shortstat", s, p])).stdout) ?? {
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
  return {
    ok: true,
    sha: h,
    replayed: 0,
    tailStaged: false,
    landedUnstaged: true,
    land: {
      top,
      baseSha: s,
      snapSha: p,
      restorable: d.filter((e) => e.s != null).map((e) => e.path),
      created: d.filter((e) => e.s == null && e.p != null).map((e) => e.path),
      stat,
    },
  };
}

/** One-shot `git diff <fromSha>..<toSha> [-- <path>]` in `cwd`, returning
 * stdout. Tolerant like the rest of run-actions — a non-zero git exit yields
 * "" rather than throwing. The single git-diff implementation shared by the
 * HTTP snapshot route and the CLI `runs diff` store-client. */
export async function gitDiff(
  git: GitExec,
  cwd: string,
  fromSha: string,
  toSha: string,
  path?: string,
): Promise<string> {
  const args = ["diff", `${fromSha}..${toSha}`];
  if (path !== undefined && path.length > 0) args.push("--", path);
  const r = await git(cwd, args);
  return r.exitCode === 0 ? r.stdout : "";
}

export type DiscardResult = { ok: true; refs: string[] } | { ok: false; reason: RunActionRefusal; detail: string };

/** Drop a run's recoverable work — delete its `refs/fragua/{snapshots,heads}`.
 * Gated like accept (terminal + in-inbox + has-worktree); idempotent past the
 * gate — a missing ref is tolerated. Never deletes `refs/fragua/bases/<id>`:
 * after an interrupted dirty-base land it is the only restore source. */
export async function applyDiscard(git: GitExec, gate: RunActionGate): Promise<DiscardResult> {
  const g = checkGate(gate);
  if (!g.ok) return g;
  const { runId } = gate;
  const cwd = g.cwd;
  const refs = [`refs/fragua/snapshots/${runId}`, `refs/fragua/heads/${runId}`];
  const deleted: string[] = [];
  for (const ref of refs) {
    const sha = await revParse(git, cwd, ref);
    if (sha == null) continue;
    await git(cwd, ["update-ref", "-d", ref]); // tolerate a concurrent delete
    deleted.push(ref);
  }
  return { ok: true, refs: deleted };
}

export type BaseRefResolution = { ok: true; sha: string; ref: string } | { ok: false; error: string };

/** Resolve a `fragua run --base <ref>` argument to a concrete commit sha, so a
 * run pins a base independent of the cwd's live HEAD. Returns the sha plus the
 * ref as typed (the human label stored on `run_state.base_git_ref`). A ref that
 * doesn't resolve — or a non-git cwd — yields `{ ok: false }` carrying git's own
 * diagnostic so the caller can refuse the enqueue with something actionable. */
export async function resolveBaseRef(git: GitExec, cwd: string, ref: string): Promise<BaseRefResolution> {
  const r = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.exitCode !== 0 || sha === "") {
    const detail = r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`;
    return { ok: false, error: `--base ${ref} is not a valid ref in ${cwd}: ${detail}` };
  }
  return { ok: true, sha, ref };
}
