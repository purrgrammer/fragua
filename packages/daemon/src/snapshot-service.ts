// Worktree snapshot service — the boundary/terminal snapshot capture and the
// terminal worktree disposal extracted from executor.ts.
//
// Two responsibilities:
//   - captureBoundarySnapshot: per-step / HITL snapshots that feed the Diff
//     scrubber (best-effort observability; never fails a run).
//   - disposeTerminalWorktree: on a hard-terminal status, capture the terminal
//     snapshot (the only thing preserving the run's work) and THEN dispose the
//     worktree — gated on the snapshot fact actually landing.
//
// Both take only the store + provisioner, not the full ExecutorOpts, so the
// service has no dependency on the loop's other knobs.

import type { FactEvent, IEventStore } from "@fragua/store";
import { TERMINAL_STATUSES } from "./executor-helpers.ts";
import { tryAppendFact } from "./occ-append.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

export interface SnapshotDeps {
  store: IEventStore;
  provisioner?: Provisioner;
}

/**
 * Per-step / HITL worktree snapshot — the Diff scrubber's feed. Called after a
 * boundary fact lands and before the next dispatch can tear the tree. Emits a
 * `snapshot.captured` observability event (delta-suppressed: nothing when the
 * tree is unchanged, or for bare-cwd runs). The terminal boundary is captured
 * in the dispose path; this skips a batch that settled the run so the same
 * tree isn't snapshotted twice. Failure is non-fatal — observability must
 * never fail a run.
 */
export async function captureBoundarySnapshot(
  deps: SnapshotDeps,
  runId: string,
  facts: FactEvent[],
  nodeId: string,
): Promise<void> {
  if (deps.provisioner == null) return;
  const isHitl = facts.some((f) => f.type === "fact.run_paused_human");
  const isStep = facts.some((f) => f.type === "fact.node_completed");
  if (!isHitl && !isStep) return;
  const post = deps.store.getState(runId);
  if (post == null || TERMINAL_STATUSES.has(post.status)) return;
  const boundary = isHitl ? "hitl" : "step";
  try {
    const snap = await deps.provisioner.snapshot(runId, boundary);
    if (snap == null) return;
    const eventIdx = post.nextSeq - 1;
    const payload =
      boundary === "hitl"
        ? {
            runId,
            eventIdx,
            nodeId: null,
            treeSha: snap.treeSha,
            commitSha: snap.commitSha,
            parentSnap: snap.parentSnap,
            headSha: snap.headSha,
            headRef: snap.headRef ?? null,
            committed: snap.committed ?? null,
            uncommitted: snap.uncommitted ?? null,
            ...(snap.diffBaseSha !== undefined ? { diffBaseSha: snap.diffBaseSha } : {}),
          }
        : {
            runId,
            eventIdx,
            nodeId,
            treeSha: snap.treeSha,
            commitSha: snap.commitSha,
            parentSnap: snap.parentSnap,
            headSha: snap.headSha,
          };
    deps.store.appendObservabilityEvents(runId, [{ type: "snapshot.captured", payload }]);
  } catch (err) {
    deps.store.appendDaemonEvent(
      {
        type: "daemon.worktree_provisioned",
        payload: {
          runId,
          ok: false,
          errorDetail: `${boundary} snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      { runId },
    );
  }
}

/**
 * Dispose the worktree env when the run reaches a hard-terminal status. We
 * intentionally skip dispose on paused_human so the env survives across HITL
 * pauses and the same worktree can be reused on resume. completed / cancelled
 * / halted / quarantined are all truly terminal — the run will never execute
 * another node.
 *
 * Before dispose removes the worktree, capture the terminal snapshot
 * (refs/fragua/{snapshots,heads}/<runId>) — the only thing preserving the
 * run's work. Its fact drives the inbox + change_stat projection. A capture
 * failure (or an OCC conflict on the snapshot fact) GATES dispose so work is
 * never lost.
 */
export async function disposeTerminalWorktree(deps: SnapshotDeps, runId: string): Promise<void> {
  if (!deps.provisioner) return;
  const finalState = deps.store.getState(runId);
  if (finalState == null || !TERMINAL_STATUSES.has(finalState.status)) return;

  let snapshotFailed = false;
  try {
    const snap = await deps.provisioner.snapshot(runId, "terminal");
    // snap === null only for bare-cwd runs (no worktree) — nothing to
    // preserve or dispose, so that's not a failure.
    if (snap != null) {
      const recorded = await tryAppendFact(deps.store, runId, finalState.version, [
        {
          type: "fact.snapshot_recorded",
          payload: {
            eventIdx: finalState.nextSeq - 1,
            treeSha: snap.treeSha,
            commitSha: snap.commitSha,
            parentSnap: snap.parentSnap,
            headSha: snap.headSha,
            headRef: snap.headRef ?? null,
            diffBaseSha: snap.diffBaseSha ?? finalState.baseGitSha ?? "",
            committed: snap.committed ?? null,
            uncommitted: snap.uncommitted ?? null,
          },
        },
      ]);
      // An OCC conflict means fact.snapshot_recorded did NOT land, so the
      // inbox/diff projection has no record of this snapshot. Treat that
      // exactly like a capture failure: retain the worktree rather than
      // dispose work the projection can't point at.
      if (!recorded) {
        snapshotFailed = true;
        deps.store.appendDaemonEvent(
          {
            type: "daemon.worktree_provisioned",
            payload: {
              runId,
              ok: false,
              errorDetail: "terminal snapshot_recorded conflicted (OCC), worktree retained for recovery",
            },
          },
          { runId },
        );
      }
    }
  } catch (err) {
    snapshotFailed = true;
    deps.store.appendDaemonEvent(
      {
        type: "daemon.worktree_provisioned",
        payload: {
          runId,
          ok: false,
          errorDetail: `terminal snapshot failed, worktree retained for recovery: ${err instanceof Error ? err.message : String(err)}`,
        },
      },
      { runId },
    );
  }

  if (!snapshotFailed) {
    try {
      await deps.provisioner.dispose(runId);
    } catch (err) {
      deps.store.appendDaemonEvent(
        {
          type: "daemon.worktree_provisioned",
          payload: {
            runId,
            ok: false,
            errorDetail: `dispose failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        { runId },
      );
    }
  }
}
