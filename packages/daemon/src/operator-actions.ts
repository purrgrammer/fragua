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

import { ConcurrencyError, type FactEvent, type IEventStore } from "@swarm/store";
import type { IntentType } from "@swarm/types";

const OPERATOR_INTENT_TYPES = ["intent.accept_run", "intent.discard_run"] as const satisfies readonly IntentType[];

interface PendingOperatorIntent {
  type: (typeof OPERATOR_INTENT_TYPES)[number];
  seq: number;
  payload: unknown;
}

/** Lowest-seq unapplied operator-action intent on the run, scanning the action
 * types and taking the earliest so actions apply in operator order. Every
 * intent is satisfiable (the action already ran in the request path; the fold
 * is pure projection), so there is no refused-set / jam to manage. */
function nextOperatorIntent(store: IEventStore, runId: string, sinceSeq: number): PendingOperatorIntent | null {
  let best: PendingOperatorIntent | null = null;
  for (const type of OPERATOR_INTENT_TYPES) {
    const it = store.getNextPendingIntent(runId, type, sinceSeq);
    if (it == null) continue;
    if (best == null || it.seq < best.seq) best = { type, seq: it.seq, payload: it.payload };
  }
  return best;
}

/**
 * Project an operator-action intent into its fact. **No git** — the action
 * (accept replay+stage / discard ref delete) already ran synchronously in the
 * request path (server route), and the intent carries its result. The daemon's
 * only job is to write the fact (the projection), keeping facts daemon-written.
 */
function applyAction(intent: PendingOperatorIntent): FactEvent {
  switch (intent.type) {
    case "intent.accept_run": {
      const p = intent.payload as { sha: string; replayed: number; tailStaged: boolean };
      return { type: "fact.run_accepted", payload: { sha: p.sha, replayed: p.replayed, tailStaged: p.tailStaged } };
    }
    case "intent.discard_run": {
      const p = intent.payload as { refs: string[] };
      return { type: "fact.run_discarded", payload: { refs: p.refs } };
    }
  }
}

/**
 * Project every unapplied operator-action intent on an inbox run into its fact
 * (`fact.run_accepted` / `fact.run_discarded`), in OCC lockstep with the inbox
 * projection. The action itself already ran synchronously in the request path
 * (server route); this sweep only writes the fact, keeping facts daemon-written.
 * Idempotent and safe on every executor tick — `getInboxActionCandidates`
 * returns nothing when no operator has acted. Returns the run ids written.
 */
export function processOperatorActions(store: IEventStore): string[] {
  const applied: string[] = [];
  for (const row of store.getInboxActionCandidates()) {
    const intent = nextOperatorIntent(store, row.runId, row.lastAppliedSeq);
    if (intent == null) continue;
    const state = store.getState(row.runId);
    if (state == null || state.inboxStatus === "discarded") continue; // terminal-terminal
    try {
      store.appendFact(row.runId, [applyAction(intent)], row.version, { advanceAppliedTo: intent.seq });
      applied.push(row.runId);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err; // OCC: retry next tick
    }
  }
  return applied;
}
