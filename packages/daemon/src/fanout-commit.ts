// The serialized fan-out commit lane, split out of the region driver
// (`fanout.ts`): the per-commit append retried against the live version, and
// the re-dispatch scan over branch lifecycle facts. This file does store I/O.
//
// ARCHITECTURE.md §6.2.

import { ClaimLostError, ConcurrencyError, type FactEvent, type IEventReader } from "@fragua/store";
import { type FanoutAppendOpts, invalidateOutputsCacheIf, type RunDeps } from "./dispatch-wiring.ts";
import { BUDGET_WARNED_KEY, readBudgetWarned, sleep } from "./executor-helpers.ts";
import type { CommitResult } from "./occ-append.ts";
import type { RunTurnState } from "./run-turn-state.ts";

/** Append attempts for a serialized fan-out commit before giving up. */
const FANOUT_COMMIT_ATTEMPTS = 8;

/** Active fan-out branches whose latest lifecycle fact is `node_aborted` — they
 * are being re-dispatched and need a fresh `dispatch_started` so they project as
 * running, not failed. */
export function abortedActiveBranches(store: IEventReader, runId: string, active: readonly string[]): string[] {
  if (active.length === 0) return [];
  const latest = new Map(store.getLatestLifecycleByNode(runId).map((r) => [r.nodeId, r.type]));
  return active.filter((n) => latest.get(n) === "fact.node_aborted");
}

/** Serialized fan-out commit lane. Re-reads the live version each attempt; a
 * sibling's commit having moved `version` is benign — retry the APPEND (never
 * re-execute). The `false` arm is TAGGED: `status` ⇒ the run left `running`,
 * `claim_lost` ⇒ the run was requeued / re-claimed (never retried), `occ` ⇒
 * genuine OCC exhaustion. */
export async function commitFanoutFact(
  deps: RunDeps,
  ts: RunTurnState,
  facts: FactEvent[],
  appendOpts: FanoutAppendOpts,
): Promise<CommitResult> {
  if (facts.length === 0) return { ok: true };
  const store = deps.opts.store;
  for (let attempt = 0; attempt < FANOUT_COMMIT_ATTEMPTS; attempt++) {
    const fresh = store.getState(deps.runId);
    if (fresh == null || fresh.status !== "running") return { ok: false, reason: "status" };
    let effectiveOpts = appendOpts;
    if (ts.pendingWarnTags.size > 0) {
      const prior = readBudgetWarned(fresh.routing);
      const merged = new Set(prior);
      for (const t of ts.pendingWarnTags) merged.add(t);
      if (merged.size > prior.size) {
        effectiveOpts = {
          ...appendOpts,
          routingPatch: { ...(appendOpts.routingPatch ?? {}), [BUDGET_WARNED_KEY]: [...merged].sort() },
        };
      }
    }
    try {
      const res = store.appendFact(deps.runId, facts, fresh.version, effectiveOpts);
      ts.lastFanoutState = res.state;
      invalidateOutputsCacheIf(ts, facts);
      return { ok: true };
    } catch (err) {
      if (err instanceof ClaimLostError) return { ok: false, reason: "claim_lost" };
      if (!(err instanceof ConcurrencyError)) throw err;
    }
    await sleep(Math.min(2 ** attempt, 16), deps.opts.shutdownSignal);
  }
  return { ok: false, reason: "occ" };
}
