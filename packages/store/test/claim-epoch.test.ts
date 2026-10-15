// run_state.claim_epoch — the dispatch-ownership fence. The claim and every
// crash requeue bump it; a fact append carrying a stale epoch is rejected.

import { describe, expect, test } from "bun:test";
import { ClaimLostError, type FactEvent, type SqliteStore } from "../src/index.ts";
import { freshStore, seedRun } from "./helpers.ts";

function startFact(store: SqliteStore, runId: string): FactEvent {
  const s = store.getState(runId)!;
  return {
    type: "fact.run_started",
    payload: { workflowSha: s.workflowSha, contractVersion: s.contractVersion, startNode: "a" },
  };
}

function seq(store: SqliteStore, runId: string): number {
  return store.getState(runId)!.nextSeq;
}

describe("claim_epoch", () => {
  test("claimNextRun increments and returns claim_epoch", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getClaimEpoch(runId)).toBe(0);

    expect(store.claimNextRun(1)).toEqual({ runId, claimEpoch: 1 });
    store.startupSweep();
    expect(store.claimNextRun(1)).toEqual({ runId, claimEpoch: 3 });
    expect(store.getClaimEpoch(runId)).toBe(3);
    store.close();
  });

  test("startupSweep requeue and quarantine bump claim_epoch", async () => {
    const store = freshStore();
    const requeued = await seedRun(store);
    const quarantined = await seedRun(store);
    for (const runId of [requeued, quarantined]) {
      store.appendFact(runId, [startFact(store, runId)], store.getState(runId)!.version);
    }
    store.appendFact(
      quarantined,
      [{ type: "fact.side_effect_intent", payload: { idempotencyKey: "k1", toolName: "t", nodeId: "a" } } as FactEvent],
      store.getState(quarantined)!.version,
    );
    const before = { r: store.getClaimEpoch(requeued)!, q: store.getClaimEpoch(quarantined)! };

    const res = store.startupSweep();
    expect(res.requeued).toContain(requeued);
    expect(res.quarantined).toContain(quarantined);
    expect(store.getClaimEpoch(requeued)).toBe(before.r + 1);
    expect(store.getClaimEpoch(quarantined)).toBe(before.q + 1);
    store.close();
  });

  test("appendFact with a stale claimEpoch throws ClaimLostError and writes nothing", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const { claimEpoch } = store.claimNextRun(1)!;
    store.startupSweep();
    store.claimNextRun(1);
    const s = store.getState(runId)!;
    const seqBefore = seq(store, runId);

    expect(() => store.appendFact(runId, [startFact(store, runId)], s.version, { claimEpoch })).toThrow(ClaimLostError);
    const after = store.getState(runId)!;
    expect(after.version).toBe(s.version);
    expect(after.nextSeq).toBe(seqBefore);

    const current = store.getClaimEpoch(runId)!;
    expect(() => store.appendFact(runId, [startFact(store, runId)], s.version, { claimEpoch: current })).not.toThrow();
    store.close();
  });

  test("appendFact of fact.run_requeued_after_crash bumps claim_epoch", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendFact(runId, [startFact(store, runId)], store.getState(runId)!.version);
    const before = store.getClaimEpoch(runId)!;

    store.appendFact(
      runId,
      [{ type: "fact.run_requeued_after_crash", payload: { prevNode: "a" } }],
      store.getState(runId)!.version,
    );
    expect(store.getClaimEpoch(runId)).toBe(before + 1);
    expect(store.getState(runId)!.status).toBe("queued");
    store.close();
  });

  test("releaseClaim requeues only when status is running and the epoch matches", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const { claimEpoch } = store.claimNextRun(1)!;
    store.appendFact(runId, [startFact(store, runId)], store.getState(runId)!.version, { claimEpoch });
    const s = store.getState(runId)!;
    const seqBefore = seq(store, runId);

    expect(store.releaseClaim(runId, claimEpoch + 1)).toBe(false);
    expect(store.getState(runId)!.status).toBe("running");
    expect(store.getState(runId)!.version).toBe(s.version);
    expect(seq(store, runId)).toBe(seqBefore);

    expect(store.releaseClaim(runId, claimEpoch, { lastAliveAt: s.dispatchStartedAt! + 50 })).toBe(true);
    const after = store.getState(runId)!;
    expect(after.status).toBe("queued");
    expect(after.currentNode).toBe("a");
    expect(after.metrics.activeMs).toBe(50);
    expect(store.getClaimEpoch(runId)).toBe(claimEpoch + 1);
    const requeue = store.getEvents(runId).find((e) => e.type === "fact.run_requeued_after_crash");
    expect(requeue?.payload).toEqual({ prevNode: "a", lastAliveAt: s.dispatchStartedAt! + 50 });

    expect(store.releaseClaim(runId, claimEpoch + 1)).toBe(false);
    store.close();
  });
});
