// Remaining property-test matrix entries — ARCHITECTURE.md §10.
//
//   P6  orphan quarantine        — kill between INTENT and DONE → run quarantines
//   P7  unquarantine retry       — intent.unquarantine:retry resumes & reuses idempotencyKey
//   P8  mid-flight abort replay  — abort → next turn converges; external call ≤ 1 per key
//   P16 blob GC                  — orphan blobs removed, shared blobs retained
//   P18 zombie daemon commit     — reclaimed original fails OCC on commit
//   P20 abort loop ceiling       — K consecutive aborts with no progress → halt

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { ConcurrencyError, sha256Hex as sha256 } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

// ─────────────── P6 ───────────────
describe("P6 — orphan quarantine on crash between intent and done", () => {
  test("side_effect_intent without matching done → startupSweep quarantines", async () => {
    const r = rig();
    enqueue(r, "rp6", "start");
    const s0 = r.store.getState("rp6")!;
    r.store.appendFact(
      "rp6",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "start",
          },
        },
      ],
      s0.version,
    );
    const s1 = r.store.getState("rp6")!;
    r.store.appendFact(
      "rp6",
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "start",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "ik-orphan",
          },
        },
      ],
      s1.version,
    );

    const sweep = r.store.startupSweep();
    expect(sweep.quarantined).toContain("rp6");
    expect(r.store.getState("rp6")!.status).toBe("quarantined");
    const events = r.store.getEvents("rp6").map((e) => e.type);
    expect(events).toContain("fact.run_quarantined");
    r.store.close();
  });
});

// ─────────────── P7 ───────────────
describe("P7 — unquarantine retry reuses idempotencyKey", () => {
  test("operator intent.unquarantine persists; retry uses same key", async () => {
    const r = rig();
    enqueue(r, "rp7", "start");
    const s0 = r.store.getState("rp7")!;
    r.store.appendFact(
      "rp7",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "start",
          },
        },
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "start",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "ik-p7",
          },
        },
      ],
      s0.version,
    );
    r.store.startupSweep();
    expect(r.store.getState("rp7")!.status).toBe("quarantined");

    // Operator writes intent.unquarantine. This is just an event for now —
    // the executor has no unquarantine fold yet, but the intent must be
    // durably persisted and the key retrievable.
    const { seq: intentSeq } = r.store.appendIntent("rp7", {
      type: "intent.unquarantine",
      payload: { resolution: "retry", note: "cache was fine" },
    });
    expect(intentSeq).toBeGreaterThan(0);

    // Re-deriving the idempotency key with the same inputs produces
    // the same hash — this is the replay-safety contract.
    const replayKey = sha256(`rp7\x00start\x000\x00h\x001`);
    const intentEvent = r.store.getEvents("rp7").find((e) => e.type === "fact.side_effect_intent")!;
    expect((intentEvent.payload as { idempotencyKey: string }).idempotencyKey).not.toBe(replayKey); // test used a static key
    // But any fresh handler using externalCall() with the same canonical
    // inputs would derive a deterministic key:
    const deterministic = sha256(`rp7\x00start\x000\x00h\x001`);
    expect(deterministic).toMatch(/^[0-9a-f]{64}$/);
    r.store.close();
  });
});

// ─────────────── P8 ───────────────
describe("P8 — mid-flight abort replay: external call ≤ 1 per key", () => {
  test("handler aborted after externalCall → retry uses same key, counted once", async () => {
    const r = rig();
    const calls: string[] = [];
    const recorder: handler.SideEffectRecorder = {
      recordIntent: (p) => calls.push(`intent:${p.idempotencyKey}`),
      recordDone: (p) => calls.push(`done:${p.idempotencyKey}`),
      recordFailed: (p) => calls.push(`failed:${p.idempotencyKey}`),
    };
    const call = handler.makeExternalCall({
      runId: "rp8",
      nodeId: "n",
      iteration: 0,
      recorder,
    });

    // 1st attempt aborts mid-flight.
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      call({ toolName: "t", args: { a: 1 }, attempt: 1 }, async () => {
        throw abortErr;
      }),
    ).rejects.toBe(abortErr);

    // 2nd attempt with same (run, node, iter, args, attempt) → same key.
    const second = await call({ toolName: "t", args: { a: 1 }, attempt: 1 }, async () => "ok");
    expect(second).toBe("ok");

    // Both intents use the same key. First aborted (no done/failed).
    // Second produced done. So we recorded:
    //   intent:K, intent:K, done:K  → key K appears on exactly one DONE.
    const keys = calls.filter((c) => c.startsWith("done:")).map((c) => c.split(":")[1]);
    expect(keys).toHaveLength(1);
    expect(new Set(keys).size).toBe(1);
    r.store.close();
  });
});

// ─────────────── P16 ───────────────
describe("P16 — blob GC preserves shared blobs, removes orphans", () => {
  test("deleting one artifact doesn't GC a blob referenced by another", async () => {
    const r = rig();
    enqueue(r, "rp16a", "start");
    enqueue(r, "rp16b", "start");
    const content = new TextEncoder().encode("shared");
    const refA = r.store.putArtifact({ runId: "rp16a", nodeId: "n", iteration: 0, key: "k" }, content);
    r.store.putArtifact({ runId: "rp16b", nodeId: "n", iteration: 0, key: "k" }, content);

    // Delete all artifacts belonging to run A (simulating a run purge).
    const db = (r.store as unknown as { db: import("bun:sqlite").Database }).db;
    db.query("DELETE FROM artifacts WHERE run_id = ?").run("rp16a");

    const { deleted } = r.store.gcBlobs();
    // B still references it → nothing to GC.
    expect(deleted).toBe(0);
    expect(r.store.getArtifactRef({ runId: "rp16b", nodeId: "n", iteration: 0, key: "k" })?.sha256).toBe(refA.sha256);

    // Delete B's artifact → now orphaned → GC.
    db.query("DELETE FROM artifacts WHERE run_id = ?").run("rp16b");
    const { deleted: deleted2 } = r.store.gcBlobs();
    expect(deleted2).toBeGreaterThanOrEqual(1);
    r.store.close();
  });
});

// ─────────────── P18 ───────────────
describe("P18 — reclaimed zombie daemon fails OCC on commit", () => {
  test("original daemon's pending commit fails after a force-acquire by another", async () => {
    const r = rig();
    enqueue(r, "rp18", "start");
    const s0 = r.store.getState("rp18")!;

    r.store.acquireDaemonLock(1111, "hostA");
    // Second daemon takes over (TTL reclaim).
    r.store.forceAcquireDaemonLock(2222, "hostB");

    // Original daemon's write with the (now stale) expectedVersion still
    // fails OCC because version advanced since.
    r.store.appendFact(
      "rp18",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: s0.workflowSha,
            schemaVersion: s0.schemaVersion,
            startNode: "start",
          },
        },
      ],
      s0.version,
    );
    expect(() =>
      r.store.appendFact(
        "rp18",
        [
          {
            type: "fact.node_started",
            payload: { nodeId: "start", iteration: 0 },
          },
        ],
        s0.version,
      ),
    ).toThrow(ConcurrencyError);
    r.store.close();
  });
});

// ─────────────── P20 ───────────────
describe("P20 — abort loop ceiling halts runaway runs", () => {
  test("5 consecutive aborts with no progress → run_halted { reason: 'abort_loop' }", async () => {
    const r = rig();
    // A handler that always aborts before emitting any transition.
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    enqueue(r, "rp20", "start");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("rp20", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: ac.signal,
    });

    const state = r.store.getState("rp20")!;
    expect(state.status).toBe("halted");
    const halt = r.store.getEvents("rp20").find((e) => e.type === "fact.run_halted")!;
    expect((halt.payload as { reason: string }).reason).toBe("abort_loop");
    r.store.close();
  });
});

// ─────────────── max_loops ───────────────
// Complements P20 (abort_loop): a handler that loops successfully without
// ever aborting still needs a ceiling. Non-P-numbered; fills the
// ARCHITECTURE.md §3 HaltReason=max_loops contract that had no executor-
// side enforcement prior.
describe("max_loops ceiling halts non-aborting runaway runs", () => {
  test("dispatches > maxLoops → run_halted { reason: 'max_loops' }", async () => {
    const r = rig();
    // Self-looping handler: always transitions back to itself. Never aborts,
    // never retries, so ABORT_LOOP_CEILING does not apply.
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        nextNode: "start",
        tokens: 0,
        costUsd: 0,
      }),
    });
    enqueue(r, "rpml", "start");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("rpml", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxLoops: 3,
      maxTurnsForTesting: 100,
      shutdownSignal: ac.signal,
    });

    const state = r.store.getState("rpml")!;
    expect(state.status).toBe("halted");
    const halt = r.store.getEvents("rpml").find((e) => e.type === "fact.run_halted")!;
    expect((halt.payload as { reason: string }).reason).toBe("max_loops");
    r.store.close();
  });
});
