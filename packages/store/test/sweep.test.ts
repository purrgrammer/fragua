// startupSweep — ARCHITECTURE.md §1.4 and §1.1.

import { describe, expect, test } from "bun:test";
import type { FactEvent } from "../src/index.ts";
import { freshStore, seedRun } from "./helpers.ts";

describe("startupSweep", () => {
  test("requeues runs that were 'running' at crash time", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    // Transition to running by emitting run_started.
    const started: FactEvent = {
      type: "fact.run_started",
      payload: {
        workflowSha: s0.workflowSha,
        schemaVersion: s0.schemaVersion,
        startNode: "a",
      },
    };
    store.appendFact(runId, [started], s0.version);
    expect(store.getState(runId)!.status).toBe("running");

    const result = store.startupSweep();
    expect(result.requeued).toContain(runId);
    const after = store.getState(runId)!;
    expect(after.status).toBe("queued");
    expect(after.currentNode).toBeNull();

    // A fact.run_requeued_after_crash event is in the log.
    const events = store.getEvents(runId);
    expect(events.some((e) => e.type === "fact.run_requeued_after_crash")).toBe(true);
    store.close();
  });

  test("quarantines runs with orphan side_effect_intent (no matching done/failed)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: {
        workflowSha: s0.workflowSha,
        schemaVersion: s0.schemaVersion,
        startNode: "a",
      },
    };
    store.appendFact(runId, [started], s0.version);
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "a",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "idem-1",
          },
        },
      ],
      s1.version,
    );

    const result = store.startupSweep();
    expect(result.quarantined).toContain(runId);
    expect(store.getState(runId)!.status).toBe("quarantined");
    store.close();
  });

  test("preserves unapplied intents across requeue (cancel filed before crash)", async () => {
    // Repro for the cancel-eaten-by-requeue bug: a user appends
    // intent.cancel_requested while the run is `running`; the daemon
    // crashes before the executor's fold can pick it up; a new daemon's
    // startup sweep flips the run back to `queued`. SPEC §3.5 + R1 in
    // docs/intent-fold.md guarantee cancel beats every other intent —
    // but only if the fold sees it. The supervisor and executor both
    // gate on `seq > lastAppliedSeq`, so sweep must not advance the
    // watermark past intents it never folded.
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );
    expect(store.getState(runId)!.status).toBe("running");

    const cancel = store.appendIntent(runId, {
      type: "intent.cancel_requested",
      payload: {},
    });

    store.startupSweep();

    expect(store.getState(runId)!.status).toBe("queued");
    // Tighter than `lastAppliedSeq < cancel.seq`: the supervisor and
    // executor read getUnappliedIntents, so the contract is that the
    // intent appears in that set after sweep.
    const unapplied = store.getUnappliedIntents(runId);
    expect(unapplied.map((e) => e.seq)).toContain(cancel.seq);
    store.close();
  });

  test("preserves unapplied intents across quarantine (cancel filed before orphan-detection)", async () => {
    // Same bug class as the requeue case, on the quarantine branch:
    // an orphan side_effect_intent crashes the run into `quarantined`
    // and the operator's pre-crash cancel must survive into wakePending.
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "a",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "idem-q",
          },
        },
      ],
      s1.version,
    );

    const cancel = store.appendIntent(runId, {
      type: "intent.cancel_requested",
      payload: {},
    });

    store.startupSweep();

    expect(store.getState(runId)!.status).toBe("quarantined");
    const unapplied = store.getUnappliedIntents(runId);
    expect(unapplied.map((e) => e.seq)).toContain(cancel.seq);
    store.close();
  });

  test("does not re-quarantine runs that already have matching done", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );
    const s1 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "a",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "idem-ok",
          },
        },
        {
          type: "fact.side_effect_done",
          payload: {
            idempotencyKey: "idem-ok",
            artifactKey: "result",
          },
        },
      ],
      s1.version,
    );

    const result = store.startupSweep();
    // The run may still be requeued (status=running), but it must NOT be quarantined.
    expect(result.quarantined).not.toContain(runId);
    expect(store.getState(runId)!.status).not.toBe("quarantined");
    store.close();
  });
});
