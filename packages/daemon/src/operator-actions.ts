// Post-terminal operator primitives (docs/proposals/worktrees.md).
//
// A run that ended with recoverable work sits in the inbox
// (`run_state.inbox_status = 'pending'`). The operator lands or drops it with
// one of two intents — accept / discard — which the server (or CLI) appends.
// This sweep is the daemon side: it folds each unapplied operator-action
// intent into a git mutation and the matching fact, in OCC lockstep with the
// inbox projection (the reducer cases drive `inbox_status` from the fact).
//
//   accept   replay the run's commits onto the operator's current branch +
//            stage the uncommitted tail (`@swarm/workspace.applyAccept`)
//   discard  update-ref -d refs/swarm/{snapshots,heads}/<runId>
//
// A refusal (accept conflict / dirty tree / missing snapshot, or a discard
// throw) yields `null` / a throw and the intent is left unadvanced — never a
// half-applied mutation. The operator revives or re-issues.

import { ConcurrencyError, type FactEvent, type IEventStore, type RunState } from "@swarm/store";
import type { IntentType } from "@swarm/types";
import { applyAccept, defaultGitExec, type GitExec } from "@swarm/workspace";

export type { GitExec };

const OPERATOR_INTENT_TYPES = ["intent.accept_run", "intent.discard_run"] as const satisfies readonly IntentType[];

/** Resolve a rev (ref or `<ref>^{tree}`) to its sha, or null when missing. */
async function revParse(git: GitExec, cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", rev]);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && sha !== "" ? sha : null;
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
 * scanning the action types and taking the earliest so actions apply in
 * operator order. Skipping refused seqs is load-bearing: without it an
 * unsatisfiable intent (e.g. an accept that conflicts) is picked every tick,
 * never advances applied-seq, and blocks every LATER operator action on the
 * run (a real jam — see processOperatorActions). */
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
    case "intent.accept_run": {
      // Replay the run's commits onto the operator's HEAD + stage the tail.
      // A conflict / dirty tree / missing snapshot is a refusal (null) — the
      // operator revives or re-issues; the server preflight rejects the common
      // cases synchronously.
      const res = await applyAccept(git, { cwd, runId, baseGitSha: state.baseGitSha ?? "" });
      if (!res.ok) return null;
      return {
        type: "fact.run_accepted",
        payload: { sha: res.sha, replayed: res.replayed, tailStaged: res.tailStaged },
      };
    }
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
