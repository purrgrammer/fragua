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
import { promisify } from "node:util";
import { type InboxStatus, isTerminal, type RunStatus } from "@fragua/types";

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
  if (gate.inboxStatus == null) return { ok: false, reason: "not_in_inbox", detail: "run has no recoverable work" };
  if (gate.inboxStatus === "discarded") return { ok: false, reason: "discarded", detail: "run already discarded" };
  if (gate.cwd == null) return { ok: false, reason: "no_worktree", detail: "run has no worktree (bare-cwd)" };
  return { ok: true, cwd: gate.cwd };
}

export type AcceptResult =
  | { ok: true; sha: string; replayed: number; tailStaged: boolean }
  | { ok: false; reason: RunActionRefusal | "no_work" | "dirty_tree" | "conflict"; detail: string };

/**
 * Land a terminal run's work on the operator's current branch (HEAD in `cwd`).
 * Replays the workflow's commits (`baseGitSha..heads`) preserving message +
 * author, then stages the uncommitted tail (the dirt that sat on top) for the
 * operator to commit. A conflict — detected up front by an in-memory
 * `merge-tree` of the whole run, or by the cherry-pick / tail-apply — leaves
 * the operator's branch and working tree untouched and returns
 * `{ ok:false, reason:"conflict" }` (resolve via revive).
 */
export async function applyAccept(git: GitExec, gate: RunActionGate): Promise<AcceptResult> {
  const g = checkGate(gate);
  if (!g.ok) return g;
  const { runId, baseGitSha } = gate;
  const cwd = g.cwd;
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
    tailStaged = true;
  }

  return { ok: true, sha: replayedTip ?? target, replayed, tailStaged };
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
 * gate — a missing ref is tolerated. */
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
