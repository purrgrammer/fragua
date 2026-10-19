// startupSweep — ARCHITECTURE.md §1.4 and §1.1.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashRequeueActiveMsDelta, deriveRunState, type FactEvent, SqliteStore } from "../src/index.ts";
import type { StoreCtx } from "../src/store-ctx.ts";
import { SWEEP_BUSY_ATTEMPTS, startupSweep } from "../src/sweep.ts";
import { freshStore, seedRun } from "./helpers.ts";

function startRun(store: SqliteStore, runId: string): void {
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
      },
    ],
    s0.version,
  );
}

function orphanIntent(idempotencyKey: string): FactEvent {
  return {
    type: "fact.side_effect_intent",
    payload: { nodeId: "a", iteration: 0, toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey },
  };
}

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (!buf.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${marker}: ${buf}`);
    buf += dec.decode(value);
  }
  reader.releaseLock();
}

describe("startupSweep", () => {
  test("a poisoned run_state row does not abort the sweep of a healthy sibling", async () => {
    const store = freshStore();
    const healthy = await seedRun(store);
    const poisoned = await seedRun(store);
    for (const runId of [healthy, poisoned]) {
      const s0 = store.getState(runId)!;
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_started",
            payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
          },
        ],
        s0.version,
      );
      expect(store.getState(runId)!.status).toBe("running");
    }

    // Corrupt the poisoned run's next_seq so its requeue event INSERT
    // collides with an existing (run_id, seq) and throws mid-sweep.
    const db = (store as unknown as { db: Database }).db;
    db.query("UPDATE run_state SET next_seq = 2 WHERE run_id = ?").run(poisoned);

    expect(() => store.startupSweep()).not.toThrow();
    expect(store.getState(healthy)!.status).toBe("queued");

    // The poisoned run's failure is recorded as an observability event
    // (skips the reducer) carrying its run id and the error message.
    const failures = store.getDaemonEvents({ runId: poisoned }).filter((e) => e.type === "daemon.sweep_run_failed");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as { runId: string }).runId).toBe(poisoned);
    expect((failures[0]!.payload as { error: string }).error).toContain("UNIQUE constraint");
    expect((failures[0]!.payload as { attempts: number }).attempts).toBe(1);
    store.close();
  });

  test("sweep quarantine credits the open dispatch span exactly as replay does", async () => {
    let t = 1_700_000_000_000;
    const store = new SqliteStore({ path: ":memory:", now: () => t });
    const runId = await seedRun(store);
    startRun(store, runId);
    store.appendFact(
      runId,
      [
        {
          type: "fact.side_effect_intent",
          payload: { nodeId: "a", iteration: 0, toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey: "k" },
        },
      ],
      store.getState(runId)!.version,
    );
    expect(store.getState(runId)!.dispatchStartedAt).not.toBeNull();
    t += 61_000;

    store.startupSweep();

    const live = store.getState(runId)!;
    expect(live.status).toBe("quarantined");
    expect(live.dispatchStartedAt).toBeNull();
    const replay = deriveRunState(runId, store.getEvents(runId));
    expect(live.metrics.activeMs).toBe(replay.metrics.activeMs);
    expect(live.metrics.activeMs).toBe(61_000);
    store.close();
  });

  test("a writer holding the lock during startupSweep delays but does not fail the requeue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-sweep-busy-"));
    const path = join(dir, "fragua.db");
    const store = new SqliteStore({ path });
    try {
      const runId = await seedRun(store);
      startRun(store, runId);
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { Database } = require("bun:sqlite");
           const db = new Database(${JSON.stringify(path)});
           db.exec("BEGIN IMMEDIATE");
           db.exec("UPDATE run_state SET updated_at = updated_at");
           console.log("locked");
           Bun.sleepSync(300);
           db.exec("COMMIT");
           db.close();`,
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      await readUntil(holder.stdout, "locked");

      const result = store.startupSweep();
      expect(await holder.exited).toBe(0);

      expect(result.requeued).toContain(runId);
      expect(store.getState(runId)!.status).toBe("queued");
      expect(store.getDaemonEvents({ runId }).some((e) => e.type === "daemon.sweep_run_failed")).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BUSY past the retry budget logs sweep_run_failed and leaves siblings healed", async () => {
    const store = freshStore();
    const a = await seedRun(store);
    const b = await seedRun(store);
    startRun(store, a);
    startRun(store, b);
    const ctx = (store as unknown as { ctx: StoreCtx }).ctx;
    let calls = 0;
    const busyCtx: StoreCtx = {
      ...ctx,
      writeTxn: (fn) => {
        calls++;
        if (calls <= SWEEP_BUSY_ATTEMPTS) {
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        ctx.writeTxn(fn);
      },
    };

    const result = startupSweep(busyCtx);

    expect(result.requeued).toHaveLength(1);
    const healed = result.requeued[0]!;
    const failed = healed === a ? b : a;
    expect(store.getState(healed)!.status).toBe("queued");
    expect(store.getState(failed)!.status).toBe("running");
    const failures = store.getDaemonEvents({ runId: failed }).filter((e) => e.type === "daemon.sweep_run_failed");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as { attempts: number }).attempts).toBe(SWEEP_BUSY_ATTEMPTS);
    expect(store.getDaemonEvents({ runId: healed }).some((e) => e.type === "daemon.sweep_run_failed")).toBe(false);
    store.close();
  });

  test("requeues runs that were 'running' at crash time", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    // Transition to running by emitting run_started.
    const started: FactEvent = {
      type: "fact.run_started",
      payload: {
        workflowSha: s0.workflowSha,
        contractVersion: s0.contractVersion,
        startNode: "a",
      },
    };
    store.appendFact(runId, [started], s0.version);
    expect(store.getState(runId)!.status).toBe("running");

    const result = store.startupSweep();
    expect(result.requeued).toContain(runId);
    const after = store.getState(runId)!;
    expect(after.status).toBe("queued");
    // Sweep preserves current_node so the executor re-dispatches the
    // in-flight node instead of re-emitting fact.run_started.
    expect(after.currentNode).toBe("a");
    expect(after.dispatchStartedAt).toBeNull();
    expect(after.nodeStartedAt).toBeNull();

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
        contractVersion: s0.contractVersion,
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
            contractVersion: s0.contractVersion,
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
            contractVersion: s0.contractVersion,
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

  test("threads priorHeartbeatAt into fact.run_requeued_after_crash.payload.lastAliveAt", async () => {
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
            contractVersion: s0.contractVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );
    expect(store.getState(runId)!.status).toBe("running");

    const HEARTBEAT_TS = 1_700_000_900_000;
    store.startupSweep({ priorHeartbeatAt: HEARTBEAT_TS });

    const events = store.getEvents(runId);
    const requeued = events.find((e) => e.type === "fact.run_requeued_after_crash")!;
    const payload = requeued.payload as { prevNode?: string; lastAliveAt?: number };
    expect(payload.lastAliveAt).toBe(HEARTBEAT_TS);
    expect(payload.prevNode).toBe("a");
    store.close();
  });

  test("credits activeMs via the same helper the reducer uses (no SQL/fold drift)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    const dispatchStartedAt = store.getState(runId)!.dispatchStartedAt;
    const HEARTBEAT_TS = (dispatchStartedAt ?? 0) + 4_321;

    store.startupSweep({ priorHeartbeatAt: HEARTBEAT_TS });

    const after = store.getState(runId)!;
    // The SQL sweep must credit exactly what the pure reducer helper computes.
    expect(after.metrics.activeMs).toBe(crashRequeueActiveMsDelta(dispatchStartedAt, HEARTBEAT_TS));
    expect(after.metrics.activeMs).toBe(4_321);
    store.close();
  });

  test("omits lastAliveAt on the clean-acquire path (no opts)", async () => {
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
            contractVersion: s0.contractVersion,
            startNode: "a",
          },
        },
      ],
      s0.version,
    );

    store.startupSweep();

    const events = store.getEvents(runId);
    const requeued = events.find((e) => e.type === "fact.run_requeued_after_crash")!;
    const payload = requeued.payload as { prevNode?: string; lastAliveAt?: number };
    expect(payload.lastAliveAt).toBeUndefined();
    expect(payload.prevNode).toBe("a");
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
            contractVersion: s0.contractVersion,
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

  test("C5: a completed run with an orphan intent is reported by neither of two sweeps", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    startRun(store, runId);
    store.appendFact(runId, [orphanIntent("idem-c5")], store.getState(runId)!.version);
    store.appendFact(
      runId,
      [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "a" } }],
      store.getState(runId)!.version,
    );
    expect(store.getState(runId)!.status).toBe("completed");

    expect(store.startupSweep().quarantined).toEqual([]);
    expect(store.startupSweep().quarantined).toEqual([]);
    expect(store.getState(runId)!.status).toBe("completed");
    store.close();
  });

  test("reports an already-quarantined run only on the sweep that quarantined it", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    startRun(store, runId);
    store.appendFact(runId, [orphanIntent("idem-once")], store.getState(runId)!.version);

    expect(store.startupSweep().quarantined).toEqual([runId]);
    expect(store.getState(runId)!.status).toBe("quarantined");
    expect(store.startupSweep().quarantined).toEqual([]);
    store.close();
  });
});
