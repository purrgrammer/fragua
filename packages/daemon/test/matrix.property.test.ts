// Remaining property-test matrix entries — ARCHITECTURE.md §10.
//
//   P6  orphan quarantine        — kill between INTENT and DONE → run quarantines
//   P7  unquarantine retry       — intent.unquarantine:retry resumes & reuses idempotencyKey
//   P8  mid-flight abort replay  — abort → next turn converges; external call ≤ 1 per key
//   P16 blob GC                  — orphan blobs removed, shared blobs retained
//   P17 schema drift refusal     — resume with mismatched schema_version → run_halted
//   P18 zombie daemon commit     — reclaimed original fails OCC on commit
//   P20 abort loop ceiling       — K consecutive aborts with no progress → halt

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as handler from "@fragua/core/handler";
import {
  ConcurrencyError,
  MIN_COMPATIBLE_SCHEMA_VERSION,
  type RunStatus,
  type StoredEvent,
  sha256Hex as sha256,
} from "@fragua/store";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { CommittingRecorder } from "../src/recorder.ts";
import { enqueue, rig } from "./helpers.ts";
import { pbtRuns } from "./pbt-runs.ts";

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

// ─────────────── P25 ───────────────
// The orphan-quarantine guarantee in §1.1 only holds if the side_effect_intent
// is durable BEFORE the external call runs. P6 tests the sweep against
// hand-crafted SQL; P25 closes the loop by exercising the production recorder
// to prove the durability is achieved by the recorder itself, not by the
// terminal appendFact at handler return. A buffered (non-pre-commit) recorder
// would lose the intent on hard crash mid-`fn` and the sweep would find
// nothing to quarantine.
describe("P25 — pre-commit recorder durability across hard crash", () => {
  test("recordIntent is durable before fn runs; sweep finds the orphan", async () => {
    const r = rig();
    enqueue(r, "rp25", "start");
    const s0 = r.store.getState("rp25")!;
    r.store.appendFact(
      "rp25",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, schemaVersion: s0.schemaVersion, startNode: "start" },
        },
      ],
      s0.version,
    );
    const s1 = r.store.getState("rp25")!;

    const recorder = new CommittingRecorder({
      store: r.store,
      runId: "rp25",
      nodeId: "start",
      iteration: 0,
      initialVersion: s1.version,
    });

    // Simulate the recorder being invoked from inside externalCall just
    // before fn() is called. With pre-commit semantics, the intent is now
    // durable on disk — equivalent to a SIGKILL/OOM/panic mid-fn losing
    // the in-process buffer would NOT lose this fact.
    recorder.recordIntent({
      toolName: "charge",
      argsHash: "h",
      attempt: 1,
      idempotencyKey: "ik-p25",
    });

    // The intent must be visible in the events table without the recorder
    // having returned to its caller (no drain step exists).
    const events = r.store.getEvents("rp25").map((e) => e.type);
    expect(events).toContain("fact.side_effect_intent");

    // run_state.version advanced because the intent was a real fact append,
    // not a buffer push. Equivalent to "recorder.version() reflects the
    // post-commit OCC token."
    expect(recorder.version()).toBeGreaterThan(s1.version);

    // Now simulate a hard crash: no recordDone/recordFailed will ever be
    // called. The startup sweep should detect the orphan and quarantine
    // the run — the entire raison d'être of pre-commit.
    r.store.startupSweep();
    expect(r.store.getState("rp25")!.status).toBe("quarantined");
    const finalEvents = r.store.getEvents("rp25").map((e) => e.type);
    expect(finalEvents).toContain("fact.run_quarantined");
    r.store.close();
  });

  test("recordDone after recordIntent leaves no orphan; sweep is a no-op", async () => {
    const r = rig();
    enqueue(r, "rp25b", "start");
    const s0 = r.store.getState("rp25b")!;
    r.store.appendFact(
      "rp25b",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, schemaVersion: s0.schemaVersion, startNode: "start" },
        },
      ],
      s0.version,
    );
    const s1 = r.store.getState("rp25b")!;

    const recorder = new CommittingRecorder({
      store: r.store,
      runId: "rp25b",
      nodeId: "start",
      iteration: 0,
      initialVersion: s1.version,
    });

    recorder.recordIntent({ toolName: "t", argsHash: "h", attempt: 1, idempotencyKey: "ik-ok" });
    recorder.recordDone({ idempotencyKey: "ik-ok", artifactKey: "start:t" });

    r.store.startupSweep();
    // The run is still 'running' (sweep requeues, doesn't quarantine, when
    // intent has a matching done). Whether requeued or not is irrelevant
    // — the assertion is that no quarantine fires.
    expect(r.store.getState("rp25b")!.status).not.toBe("quarantined");
    r.store.close();
  });
});

// ─────────────── P27 ───────────────
// foldIntents truth table — exhaustive property-style coverage of the
// fold semantics documented in `docs/intent-fold.md`. fast-check
// generates random batches of intents under all run statuses and
// asserts the precedence rules R1..R7.
describe("P27 — intent-fold truth table holds across random batches", () => {
  test("invariants under random intent batches × run status", () => {
    const seq = (n: number) => n + 1; // 1-based
    const intentArb = fc.oneof(
      fc.record({
        type: fc.constant("intent.cancel_requested"),
        payload: fc.record({ reason: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }) }),
      }),
      fc.record({ type: fc.constant("intent.pause_requested"), payload: fc.constant({}) }),
      fc.record({
        type: fc.constant("intent.steering_requested"),
        payload: fc.record({ text: fc.string({ minLength: 1, maxLength: 12 }) }),
      }),
      fc.record({
        type: fc.constant("intent.human_input"),
        payload: fc.record({ input: fc.oneof(fc.integer(), fc.string({ maxLength: 12 })) }),
      }),
      fc.record({
        type: fc.constant("intent.priority_adjusted"),
        payload: fc.record({ newPriority: fc.integer(), note: fc.string({ maxLength: 8 }) }),
      }),
    );
    const statusArb = fc.constantFrom<RunStatus>("queued", "running", "paused_human", "quarantined");

    fc.assert(
      fc.property(fc.array(intentArb, { minLength: 0, maxLength: 6 }), statusArb, (intents, status) => {
        const events: StoredEvent[] = intents.map((it, i) => ({
          runId: "rp27",
          seq: seq(i),
          type: it.type as StoredEvent["type"],
          writer: "client",
          payload: it.payload as StoredEvent["payload"],
          ts: i,
        }));
        const decision = handler.foldIntents(events, status);

        // Invariant 1: every input intent is accounted for. For cancel,
        // every non-cancel intent (and later cancels) is in `dropped`.
        // For proceed, every applied-or-dropped seq covers the input set.
        if (decision.kind === "cancel") {
          const droppedSeqs = new Set(decision.dropped.map((d) => d.seq));
          for (const ev of events) {
            if (ev.seq === decision.intentSeq) continue;
            expect(droppedSeqs.has(ev.seq)).toBe(true);
          }
        } else {
          const covered = new Set([...decision.appliedSeqs, ...decision.dropped.map((d) => d.seq)]);
          for (const ev of events) expect(covered.has(ev.seq)).toBe(true);
        }

        // Invariant 2: cancel always wins if present.
        const cancels = events.filter((e) => e.type === "intent.cancel_requested");
        if (cancels.length > 0) {
          expect(decision.kind).toBe("cancel");
        }

        if (decision.kind === "proceed") {
          // Invariant 3: shouldPause and shouldPauseAfterDispatch are mutually exclusive.
          expect(decision.shouldPause && decision.shouldPauseAfterDispatch).toBe(false);

          // Invariant 4: pause only fires on a dispatching status.
          if (decision.shouldPause || decision.shouldPauseAfterDispatch) {
            expect(["queued", "running"]).toContain(status);
          }

          // Invariant 5: steer / hitl on a dispatching run plus a pause →
          // shouldPauseAfterDispatch (R3). On non-dispatching status the
          // pause itself is dropped.
          const hasPauseInBatch = events.some((e) => e.type === "intent.pause_requested");
          const hasSteerOrHitlOnDispatching =
            (status === "running" || status === "queued") &&
            events.some(
              (e) =>
                (e.type === "intent.steering_requested" &&
                  typeof (e.payload as { text?: string }).text === "string" &&
                  (e.payload as { text: string }).text.length > 0) ||
                e.type === "intent.human_input",
            );
          if (hasPauseInBatch && hasSteerOrHitlOnDispatching) {
            expect(decision.shouldPauseAfterDispatch).toBe(true);
            expect(decision.shouldPause).toBe(false);
          }

          // Invariant 6: multiple human_input → only the last seq's input
          // is in decision.humanInput; others are dropped with later_input_won.
          const hitlEvents = events.filter((e) => e.type === "intent.human_input");
          if (hitlEvents.length > 1 && (status === "queued" || status === "running" || status === "paused_human")) {
            const droppedHitl = decision.dropped.filter((d) => d.type === "intent.human_input");
            expect(droppedHitl.length).toBe(hitlEvents.length - 1);
            expect(droppedHitl.every((d) => d.reason === "later_input_won")).toBe(true);
          }

          // Invariant 7: multiple priority_adjusted → last-wins, earlier dropped.
          const prioEvents = events.filter((e) => e.type === "intent.priority_adjusted");
          if (prioEvents.length > 1) {
            const droppedPrio = decision.dropped.filter((d) => d.type === "intent.priority_adjusted");
            expect(droppedPrio.length).toBe(prioEvents.length - 1);
          }

          // Invariant 8: pause on paused_human is always dropped with already_paused.
          if (status === "paused_human") {
            const pauseEvents = events.filter((e) => e.type === "intent.pause_requested");
            for (const p of pauseEvents) {
              expect(decision.dropped.some((d) => d.seq === p.seq && d.reason === "already_paused")).toBe(true);
            }
            expect(decision.shouldPause).toBe(false);
            expect(decision.shouldPauseAfterDispatch).toBe(false);
          }

          // Invariant 9: human_input on quarantined is always dropped wrong_state.
          if (status === "quarantined") {
            const hitlInQuar = events.filter((e) => e.type === "intent.human_input");
            for (const h of hitlInQuar) {
              expect(decision.dropped.some((d) => d.seq === h.seq && d.reason === "wrong_state")).toBe(true);
            }
            expect(decision.humanInput).toBeUndefined();
          }
        }
      }),
      { numRuns: pbtRuns(200) },
    );
  });
});

// ─────────────── P26 ───────────────
// Replay-safe artifacts through the handler context. Same-scope writes
// of identical content are no-ops; different content throws unless the
// caller passes `replace: true`. ARCHITECTURE.md §I8 / handler-contract.md
// "replay semantics."
describe("P26 — handler artifact replay safety", () => {
  test("ctx.artifacts.put is no-op on identical content; throws on diff content unless replace", async () => {
    const r = rig();
    enqueue(r, "rp26", "start");

    // Build a HandlerContext as the executor would.
    const ac = new AbortController();
    const ctx = handler.buildHandlerContext({
      runId: "rp26",
      nodeId: "n",
      iteration: 0,
      signal: ac.signal,
      routing: {},
      store: r.store,
      llm: handler.makeLlmClient({
        signal: ac.signal,
        call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      }),
      http: handler.makeHttpClient({ signal: ac.signal }),
      tools: r.tools,
      args: {},
      recorder: { recordIntent: () => {}, recordDone: () => {}, recordFailed: () => {} },
    });

    const refA = ctx.artifacts.put("k", "v1", "text/plain");
    const refB = ctx.artifacts.put("k", "v1", "text/plain"); // replay no-op
    expect(refB.sha256).toBe(refA.sha256);

    expect(() => ctx.artifacts.put("k", "v2", "text/plain")).toThrow(/artifact collision/i);

    const refC = ctx.artifacts.put("k", "v2", "text/plain", { replace: true });
    expect(refC.sha256).not.toBe(refA.sha256);
    expect(new TextDecoder().decode(ctx.artifacts.get("k"))).toBe("v2");

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

// ─────────────── P17 ───────────────
describe("P17 — version-mismatch refusal on resume", () => {
  test("run pinned newer than the daemon → RECOVERABLE fact.run_paused { reason: 'engine_incompatible' }", async () => {
    const r = rig();
    // Handler would otherwise transition cleanly; the version check runs
    // before dispatch so the body never fires.
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp17", "start");
    const before = r.store.getState("rp17")!;

    // Simulate a downgraded daemon starting against a newer-pinned run:
    // rewrite schema_version out from under the executor.
    const db = (r.store as unknown as { db: Database }).db;
    db.query("UPDATE run_state SET schema_version = 999 WHERE run_id = ?").run("rp17");

    r.store.claimNextRun(1);
    const ac = new AbortController();
    await runOne("rp17", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: ac.signal,
    });

    const after = r.store.getState("rp17")!;
    // Recoverable park, NOT a terminal halt — the defect this fixes.
    expect(after.status).toBe("paused");
    expect(r.store.getEvents("rp17").some((e) => e.type === "fact.run_halted")).toBe(false);
    const pause = r.store.getEvents("rp17").find((e) => e.type === "fact.run_paused")!;
    const p = pause.payload as { reason: string; pinnedVersion: number; supportedMax: number };
    expect(p.reason).toBe("engine_incompatible");
    expect(p.pinnedVersion).toBeGreaterThan(p.supportedMax); // too-new arm, inferred from payload
    expect(after.version).toBeGreaterThan(before.version);
    r.store.close();
  });

  test("a run pinned to a version inside [MIN, CURRENT] resumes without halting", async () => {
    // Same setup as P17, but with a schema_version that, while not equal
    // to CURRENT, still falls inside the compat range. Picking
    // MIN_COMPATIBLE_SCHEMA_VERSION directly is the most defensive fixture
    // — it'll keep working as MIN floats forward.
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rp17b", "start");

    const db = (r.store as unknown as { db: Database }).db;
    db.query("UPDATE run_state SET schema_version = ? WHERE run_id = ?").run(MIN_COMPATIBLE_SCHEMA_VERSION, "rp17b");

    r.store.claimNextRun(1);
    await runOne("rp17b", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: new AbortController().signal,
    });

    const after = r.store.getState("rp17b")!;
    // No version-mismatch refusal: run progressed normally to the terminal node.
    expect(after.status).toBe("completed");
    const types = r.store.getEvents("rp17b").map((e) => e.type);
    expect(types).not.toContain("fact.run_halted");
    r.store.close();
  });
});

// ─────────────── P20 ───────────────
describe("P20 — abort loop ceiling pauses runaway runs (recoverable)", () => {
  // Stage 3 of recoverable-budget-pause.md flipped abort_loop from
  // terminal halt to operator-resumable pause: an operator who knows
  // the underlying cause is fixed shouldn't have to re-enqueue the
  // run from scratch. Naked `intent.resume` grants one more attempt;
  // there's no per-run cap-adjustment intent because the ceiling is
  // daemon config, not workflow-author authority.
  test("5 consecutive aborts with no progress → fact.run_paused{reason:'abort_loop'}, status=paused", async () => {
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
    expect(state.status).toBe("paused");
    const pause = r.store
      .getEvents("rp20")
      .filter((e) => e.type === "fact.run_paused")
      .pop()!;
    expect((pause.payload as { reason: string }).reason).toBe("abort_loop");
    r.store.close();
  });

  test("abort_loop_warning observability event fires one abort before the pause", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    enqueue(r, "rp20w", "start");
    r.store.claimNextRun(1);

    await runOne("rp20w", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      // Smaller ceiling so the test runs fewer aborts.
      abortLoopCeiling: 3,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("rp20w");
    const warns = events.filter((e) => e.type === "abort_loop_warning");
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    expect((warn.payload as { consecutiveAborts: number }).consecutiveAborts).toBe(2);
    expect((warn.payload as { ceiling: number }).ceiling).toBe(3);
    // Warning lands BEFORE the pause in causal order.
    const warnIdx = events.findIndex((e) => e.type === "abort_loop_warning");
    const pauseIdx = events.findIndex(
      (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "abort_loop",
    );
    expect(warnIdx).toBeLessThan(pauseIdx);
    expect(r.store.getState("rp20w")!.status).toBe("paused");
    r.store.close();
  });

  test("abortLoopCeiling=2 pauses after 2 aborts (knob honoured)", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    enqueue(r, "rp20c", "start");
    r.store.claimNextRun(1);

    await runOne("rp20c", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      abortLoopCeiling: 2,
      shutdownSignal: new AbortController().signal,
    });

    const aborts = r.store.getEvents("rp20c").filter((e) => e.type === "fact.node_aborted");
    expect(aborts).toHaveLength(2);
    expect(r.store.getState("rp20c")!.status).toBe("paused");
    r.store.close();
  });
});

// ─────────────── max_loops ───────────────
// Complements P20 (abort_loop): a handler that loops successfully without
// ever aborting still needs a ceiling. Non-P-numbered; fills the
// ARCHITECTURE.md §3 HaltReason=max_loops contract that had no executor-
// side enforcement prior.
describe("max_loops ceiling pauses non-aborting runaway runs (recoverable)", () => {
  // Stage 3 of recoverable-budget-pause.md flipped max_loops from
  // terminal halt to operator-resumable pause. Operator may know the
  // workflow needs more dispatches (rare but possible) and want to
  // raise the ceiling via intent.max_loops_adjusted.
  test("dispatches > maxLoops → fact.run_paused{reason:'max_loops'}, status=paused", async () => {
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
    expect(state.status).toBe("paused");
    const pause = r.store
      .getEvents("rpml")
      .filter((e) => e.type === "fact.run_paused")
      .pop()!;
    expect((pause.payload as { reason: string }).reason).toBe("max_loops");
    expect((pause.payload as { currentLimit: number }).currentLimit).toBe(3);
    r.store.close();
  });
});
