// Post-terminal operator primitives (docs/proposals/worktrees.md step 7).
//
// A run that ended with recoverable work sits in the inbox
// (`run_state.inbox_status = 'pending'`). The operator promotes or drops it
// with one of four intents — branch / commit / merge / discard — which the
// server appends after validating the user-facing preconditions. This sweep
// is the daemon side: it folds each unapplied operator-action intent into a
// git mutation and the matching fact, in OCC lockstep with the inbox
// projection (the 7a reducer cases drive `inbox_status` from the fact).
//
// Worktree-free by invariant: by terminal the worktree is gone, so every
// action is pure object-DB plumbing against the persisted
// `refs/swarm/{snapshots,heads}/<runId>` refs in the run's cwd:
//
//   branch   update-ref refs/heads/<branch> <heads-sha>      (committed history)
//   commit   commit-tree <snapshot-tree> -p <onto> → update-ref <onto>  (full tree)
//   merge    ff: update-ref <into> <heads-sha>; no-ff/squash: merge-tree → commit-tree
//   discard  update-ref -d refs/swarm/{snapshots,heads}/<runId>
//
// Validation split: the server (POST /runs/:id/{branch,commit,merge,discard})
// owns user-facing refusals (detached/relocated target, nothing-to-branch,
// non-ff without --no-ff/--squash, merge conflict) and returns 4xx
// synchronously using its own git reader. This sweep is defense-in-depth: a
// precondition that still fails here (a can't-happen invalid intent, or a
// rare target-moved TOCTOU) yields `null` / a throw and the intent is left
// unadvanced — never a half-applied mutation. Commit/merge mutations use a
// compare-and-swap `update-ref <new> <old>` so a moved target either
// self-heals on the next tick (commit recomputes its parent) or no-ops.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConcurrencyError, type FactEvent, type IEventStore, type RunState } from "@swarm/store";
import type { IntentType } from "@swarm/types";

const execFileP = promisify(execFile);

/** Runs `git <args>` in `cwd`, capturing output and exit code without
 * throwing — operator-action plumbing branches on exit code. Injectable for
 * tests against a fixture repo. */
export type GitExec = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultGitExec: GitExec = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileP("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
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

const OPERATOR_INTENT_TYPES = [
  "intent.branch_run",
  "intent.commit_run",
  "intent.merge_run",
  "intent.discard_run",
] as const satisfies readonly IntentType[];

/** Resolve a rev (ref or `<ref>^{tree}`) to its sha, or null when missing. */
async function revParse(git: GitExec, cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", rev]);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && sha !== "" ? sha : null;
}

/** Run a mutating git command; throw with stderr on a non-zero exit so the
 * sweep leaves the intent unadvanced (caught per-candidate). */
async function mustGit(git: GitExec, cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

async function applyBranch(
  git: GitExec,
  cwd: string,
  runId: string,
  payload: { branch: string; force?: boolean },
): Promise<FactEvent | null> {
  const headsSha = await revParse(git, cwd, `refs/swarm/heads/${runId}`);
  if (headsSha == null) return null; // no committed history to promote
  const targetRef = `refs/heads/${payload.branch}`;
  const exists = (await revParse(git, cwd, targetRef)) != null;
  if (exists && payload.force !== true) return null; // would clobber without --force
  await mustGit(git, cwd, ["update-ref", targetRef, headsSha]);
  return { type: "fact.run_branched", payload: { branch: payload.branch, sha: headsSha } };
}

async function applyCommit(
  git: GitExec,
  cwd: string,
  runId: string,
  state: RunState,
  payload: { message: string; onto?: string },
): Promise<FactEvent | null> {
  const onto = payload.onto ?? state.baseGitRef;
  if (onto == null || onto === "") return null; // no default target (detached provision)
  const tree = await revParse(git, cwd, `refs/swarm/snapshots/${runId}^{tree}`);
  if (tree == null) return null;
  const parentSha = await revParse(git, cwd, onto);
  if (parentSha == null) return null; // target branch vanished
  const commitSha = await mustGit(git, cwd, ["commit-tree", tree, "-p", parentSha, "-m", payload.message]);
  // CAS: refuse if `onto` moved since we read parentSha. Next tick recomputes.
  await mustGit(git, cwd, ["update-ref", `refs/heads/${onto}`, commitSha, parentSha]);
  return {
    type: "fact.run_committed",
    payload: { targetBranch: onto, sha: commitSha, message: payload.message, parentSha },
  };
}

async function applyMerge(
  git: GitExec,
  cwd: string,
  runId: string,
  state: RunState,
  payload: { mode?: "ff" | "no-ff" | "squash"; into?: string },
): Promise<FactEvent | null> {
  const into = payload.into ?? state.baseGitRef;
  if (into == null || into === "") return null;
  const headsSha = await revParse(git, cwd, `refs/swarm/heads/${runId}`);
  if (headsSha == null) return null;
  const intoSha = await revParse(git, cwd, into);
  if (intoSha == null) return null;
  const mode = payload.mode ?? "ff";

  if (mode === "ff") {
    const ff = await git(cwd, ["merge-base", "--is-ancestor", intoSha, headsSha]);
    if (ff.exitCode !== 0) return null; // not fast-forwardable
    await mustGit(git, cwd, ["update-ref", `refs/heads/${into}`, headsSha, intoSha]);
    return {
      type: "fact.run_merged",
      payload: { targetBranch: into, mode: "ff", sha: headsSha, parentShas: [intoSha, headsSha] },
    };
  }

  const mt = await git(cwd, ["merge-tree", "--write-tree", intoSha, headsSha]);
  if (mt.exitCode !== 0) return null; // conflict — operator must revive
  const mergedTree = mt.stdout.trim().split("\n")[0] ?? "";
  if (mergedTree === "") return null;
  const message = state.title != null && state.title !== "" ? state.title : `Merge swarm run ${runId}`;
  const commitArgs = ["commit-tree", mergedTree, "-p", intoSha];
  if (mode === "no-ff") commitArgs.push("-p", headsSha);
  commitArgs.push("-m", message);
  const commitSha = await mustGit(git, cwd, commitArgs);
  await mustGit(git, cwd, ["update-ref", `refs/heads/${into}`, commitSha, intoSha]);
  return {
    type: "fact.run_merged",
    payload: {
      targetBranch: into,
      mode: mode === "no-ff" ? "merge" : "squash",
      sha: commitSha,
      parentShas: mode === "no-ff" ? [intoSha, headsSha] : [intoSha],
    },
  };
}

async function applyDiscard(git: GitExec, cwd: string, runId: string): Promise<FactEvent | null> {
  const refs: string[] = [];
  for (const ref of [`refs/swarm/snapshots/${runId}`, `refs/swarm/heads/${runId}`]) {
    if ((await revParse(git, cwd, ref)) == null) continue;
    await git(cwd, ["update-ref", "-d", ref]); // tolerate a concurrent delete
    refs.push(ref);
  }
  return { type: "fact.run_discarded", payload: { refs } };
}

interface PendingOperatorIntent {
  type: (typeof OPERATOR_INTENT_TYPES)[number];
  seq: number;
  payload: unknown;
}

/** Lowest-seq unapplied operator-action intent on the run NOT in `refused`,
 * scanning the four types and taking the earliest so actions apply in
 * operator order. Skipping refused seqs is load-bearing: without it an
 * unsatisfiable intent (e.g. `branch <existing>` without `--force`) is picked
 * every tick, never advances applied-seq, and blocks every LATER operator
 * action on the run (a real jam — see processOperatorActions). */
function nextOperatorIntent(
  store: IEventStore,
  runId: string,
  sinceSeq: number,
  refused: ReadonlySet<string>,
): PendingOperatorIntent | null {
  let best: PendingOperatorIntent | null = null;
  for (const type of OPERATOR_INTENT_TYPES) {
    let since = sinceSeq;
    // Walk forward past any refused seqs of this type to the next live one.
    for (;;) {
      const it = store.getNextPendingIntent(runId, type, since);
      if (it == null) break;
      if (refused.has(`${runId}:${it.seq}`)) {
        since = it.seq;
        continue;
      }
      if (best == null || it.seq < best.seq) best = { type, seq: it.seq, payload: it.payload };
      break;
    }
  }
  return best;
}

async function applyAction(
  git: GitExec,
  cwd: string,
  runId: string,
  state: RunState,
  intent: PendingOperatorIntent,
): Promise<FactEvent | null> {
  switch (intent.type) {
    case "intent.branch_run":
      return applyBranch(git, cwd, runId, intent.payload as { branch: string; force?: boolean });
    case "intent.commit_run":
      return applyCommit(git, cwd, runId, state, intent.payload as { message: string; onto?: string });
    case "intent.merge_run":
      return applyMerge(git, cwd, runId, state, intent.payload as { mode?: "ff" | "no-ff" | "squash"; into?: string });
    case "intent.discard_run":
      return applyDiscard(git, cwd, runId);
  }
}

/**
 * Fold every actionable operator-action intent on an inbox run into its git
 * mutation + fact. Idempotent and safe to call on every executor tick — the
 * scoped candidate query (`getInboxActionCandidates`) returns nothing when no
 * operator has acted. Returns the run ids whose intent was applied this pass.
 *
 * `refused` is the executor's persistent set of `${runId}:${seq}` intents that
 * couldn't be applied (precondition unmet, or the git mutation threw). It's
 * load-bearing: a refused intent can't advance applied-seq (appendFact needs a
 * fact), so without remembering it the sweep would re-pick it forever and jam
 * every later operator action on the run. Recording it lets the next live
 * intent through. Cost: a genuinely transient git failure won't auto-retry —
 * the operator re-issues (a fresh, higher-seq intent). That tradeoff beats a
 * stuck queue; the common refusals (branch collision, non-ff, conflict) are
 * the server's job to reject synchronously anyway.
 */
export async function processOperatorActions(
  store: IEventStore,
  opts: { git?: GitExec; refused?: Set<string> } = {},
): Promise<string[]> {
  const git = opts.git ?? defaultGitExec;
  const refused = opts.refused ?? new Set<string>();
  const applied: string[] = [];
  for (const row of store.getInboxActionCandidates()) {
    const intent = nextOperatorIntent(store, row.runId, row.lastAppliedSeq, refused);
    if (intent == null) continue;
    const state = store.getState(row.runId);
    if (state?.cwd == null) continue;
    if (state.inboxStatus === "discarded") continue; // terminal-terminal

    let fact: FactEvent | null;
    try {
      fact = await applyAction(git, state.cwd, row.runId, state, intent);
    } catch {
      refused.add(`${row.runId}:${intent.seq}`); // don't jam the queue on a throw
      continue;
    }
    if (fact == null) {
      refused.add(`${row.runId}:${intent.seq}`); // precondition unmet — never satisfiable
      continue;
    }

    try {
      store.appendFact(row.runId, [fact], row.version, { advanceAppliedTo: intent.seq });
      applied.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
    }
  }
  return applied;
}
