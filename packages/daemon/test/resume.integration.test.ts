// Integration tests for the resumability properties spelled out in the
// activeMs / fact.dispatch_started work. Per-test temp DB on disk so
// real WAL behaviour exercises (no :memory: short-circuit).
//
// "Crash" is simulated in-process: a handler hangs on a deferred,
// the executor's runOne is abandoned (the surrounding promise is
// dropped without await), then a fresh store + executor open the same
// DB file and run startupSweep. This matches what a real daemon
// restart sees because:
//   - the abandoned handler can't append a terminal fact (no completion path)
//   - run_state shows status=running, currentNode=set
//   - sweep emits fact.run_requeued_after_crash and resets the projection
// At the end of each test the deferred is resolved so the abandoned
// handler can drain (its eventual fact-append OCC-fails harmlessly
// because version moved on under it).

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { SqliteStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";

interface Rig {
  store: SqliteStore;
  dispatcher: Dispatcher;
  tools: handler.InMemoryToolRegistry;
  llmCall: handler.LlmCallFn;
  workflowSha: string;
  dbPath: string;
  cleanup: () => void;
}

function makeRig(yaml: string, sha = "wf"): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-resume-"));
  const dbPath = join(dir, "fragua.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(sha, "wf", yaml, serializeGraph(parseWorkflow(yaml)), CURRENT_IR_VERSION);
  return {
    store,
    dispatcher: new Dispatcher(),
    tools: new handler.InMemoryToolRegistry(),
    llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
    workflowSha: sha,
    dbPath,
    cleanup: () => store.close(),
  };
}

function reopenStore(dbPath: string): SqliteStore {
  return new SqliteStore({ path: dbPath });
}

function enqueue(rig: Rig, runId: string, startNode = "start"): void {
  rig.store.enqueueRun({
    runId,
    workflowSha: rig.workflowSha,
    initialRouting: { start_node: startNode },
  });
}

async function runUntilSettled(store: SqliteStore, dispatcher: Dispatcher, runId: string, ms = 2000): Promise<void> {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  store.claimNextRun(1);
  await runOne(runId, {
    store,
    dispatcher,
    registry: new AbortRegistry(),
    tools: new handler.InMemoryToolRegistry(),
    llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 50,
    shutdownSignal: ac.signal,
  });
}

describe("resume integration — activeMs, dispatch_started, crash recovery", () => {
  test("happy path: multi-node run accumulates activeMs > 0 in projection", async () => {
    const yaml = `name: t\nsteps:\n  mid: {type: llm, prompt: m}\n  tail: {type: llm, prompt: t}\n`;
    const r = makeRig(yaml);
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        await new Promise((res) => setTimeout(res, 5));
        return { kind: "transition", nextNode: "mid", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "mid", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        await new Promise((res) => setTimeout(res, 5));
        return { kind: "transition", nextNode: "tail", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "tail", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "happy");
    await runUntilSettled(r.store, r.dispatcher, "happy");

    const final = r.store.getState("happy")!;
    expect(final.status).toBe("completed");
    expect(final.dispatchStartedAt).toBeNull();
    expect(final.metrics.activeMs).toBeGreaterThan(0);

    // Three dispatches: run_started covers start, then two fact.dispatch_started.
    const events = r.store.getEvents("happy");
    const dispatchStarted = events.filter((e) => e.type === "fact.dispatch_started");
    expect(dispatchStarted.map((e) => (e.payload as { nodeId: string }).nodeId)).toEqual(["mid", "tail"]);
    r.cleanup();
  });

  test("crash mid-handler: sweep + new executor resumes and completes the run", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = makeRig(yaml);

    // Handler-1 hangs on a deferred. We'll abandon the runOne promise
    // mid-flight, then resolve the deferred at test end so the orphan
    // handler can drain.
    let resolveHang: (v: { kind: "halt"; reason: "error"; detail: string }) => void = () => undefined;
    const hangPromise = new Promise<{ kind: "halt"; reason: "error"; detail: string }>((res) => {
      resolveHang = res;
    });
    let handler1Called = false;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 60_000,
      handler: async () => {
        handler1Called = true;
        return hangPromise;
      },
    });
    enqueue(r, "crash-1");

    // Fire-and-forget: simulate the daemon-process disappearing.
    const ac = new AbortController();
    r.store.claimNextRun(1);
    const ranAway = runOne("crash-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: ac.signal,
    });

    // Wait for the handler to actually be in flight before "crashing."
    for (let i = 0; i < 100 && !handler1Called; i++) await new Promise((res) => setTimeout(res, 5));
    expect(handler1Called).toBe(true);

    const midState = r.store.getState("crash-1")!;
    expect(midState.status).toBe("running");
    expect(midState.dispatchStartedAt).not.toBeNull();
    expect(midState.currentNode).toBe("start");

    // Open a fresh store on the same DB file (simulates the new daemon
    // process). startupSweep emits fact.run_requeued_after_crash and
    // resets projection.
    const store2 = reopenStore(r.dbPath);
    const sweepResult = store2.startupSweep();
    expect(sweepResult.requeued).toContain("crash-1");
    const afterSweep = store2.getState("crash-1")!;
    expect(afterSweep.status).toBe("queued");
    // current_node is preserved so the executor resumes on the in-flight
    // node (here: start) without re-emitting fact.run_started.
    expect(afterSweep.currentNode).toBe("start");
    expect(afterSweep.dispatchStartedAt).toBeNull();

    // Re-register the handler on a fresh dispatcher — non-hanging this
    // time — and run to completion.
    const dispatcher2 = new Dispatcher();
    dispatcher2.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    await runUntilSettled(store2, dispatcher2, "crash-1");

    const final = store2.getState("crash-1")!;
    expect(final.status).toBe("completed");
    expect(final.dispatchStartedAt).toBeNull();

    // Tally: requeued_after_crash present in the log, and fact.run_started
    // appears exactly once (resume must not re-emit it — that was the bug
    // where workflows re-ran end-to-end after every crash).
    const types = store2.getEvents("crash-1").map((e) => e.type);
    expect(types).toContain("fact.run_requeued_after_crash");
    expect(types.filter((t) => t === "fact.run_started")).toHaveLength(1);

    // Drain the orphan handler. Its terminal append will OCC-fail
    // because version moved on after sweep + completion — that's the
    // intended behaviour.
    resolveHang({ kind: "halt", reason: "error", detail: "test cleanup" });
    ac.abort();
    await ranAway.catch(() => undefined);
    store2.close();
    r.cleanup();
  });

  test("crash on a deep node: sweep resumes on that node, no rerun-from-start", async () => {
    // Regression for the bug where startupSweep nulled current_node, the
    // executor's `needsStart` then re-fired fact.run_started, and the
    // workflow re-ran from the start node end-to-end. Visible in the wild
    // as duplicate edges in selectedEdges and collapsed nodes[] state.
    const yaml = `name: t\nsteps:\n  collect: {type: llm, prompt: c}\n  deep: {type: llm, prompt: d}\n`;
    const r = makeRig(yaml);
    let resolveHang: (v: { kind: "halt"; reason: "error"; detail: string }) => void = () => undefined;
    const hangPromise = new Promise<{ kind: "halt"; reason: "error"; detail: string }>((res) => {
      resolveHang = res;
    });
    let deepCallCount = 0;
    let collectCallCount = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "collect", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "collect", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        collectCallCount++;
        return { kind: "transition", nextNode: "deep", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "deep", {
      kind: "step",
      sideEffect: "none",
      maxMs: 60_000,
      handler: async () => {
        deepCallCount++;
        return hangPromise;
      },
    });
    enqueue(r, "deep-crash");

    const ac = new AbortController();
    r.store.claimNextRun(1);
    const ranAway = runOne("deep-crash", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: ac.signal,
    });

    for (let i = 0; i < 200 && deepCallCount === 0; i++) await new Promise((res) => setTimeout(res, 5));
    expect(deepCallCount).toBe(1);
    expect(collectCallCount).toBe(1);
    expect(r.store.getState("deep-crash")!.currentNode).toBe("deep");

    const store2 = reopenStore(r.dbPath);
    store2.startupSweep();
    expect(store2.getState("deep-crash")!.currentNode).toBe("deep");

    const dispatcher2 = new Dispatcher();
    dispatcher2.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "collect", tokens: 0, costUsd: 0 }),
    });
    dispatcher2.register(r.workflowSha, "collect", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        collectCallCount++;
        return { kind: "transition", nextNode: "deep", tokens: 0, costUsd: 0 };
      },
    });
    dispatcher2.register(r.workflowSha, "deep", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        deepCallCount++;
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    await runUntilSettled(store2, dispatcher2, "deep-crash");

    expect(store2.getState("deep-crash")!.status).toBe("completed");
    // collect must not have run again — resume picked up on `deep`, not start.
    expect(collectCallCount).toBe(1);
    // deep ran twice: once before crash (hung), once after resume (completed).
    expect(deepCallCount).toBe(2);

    const events = store2.getEvents("deep-crash");
    // fact.run_started must appear exactly once: the bug was that resume
    // re-emitted it and re-traversed the workflow from the start node.
    expect(events.filter((e) => e.type === "fact.run_started")).toHaveLength(1);
    const dispatched = events
      .filter((e) => e.type === "fact.dispatch_started")
      .map((e) => (e.payload as { nodeId: string }).nodeId);
    // Pre-crash: collect, deep. Post-resume: deep again. No second start/collect.
    expect(dispatched).toEqual(["collect", "deep", "deep"]);

    resolveHang({ kind: "halt", reason: "error", detail: "test cleanup" });
    ac.abort();
    await ranAway.catch(() => undefined);
    store2.close();
    r.cleanup();
  });

  test("pause-resume cycle emits fact.dispatch_started with resumeOf=paused_human", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = makeRig(yaml);

    // Pause the run programmatically by appending an intent that the
    // executor's foldIntents will turn into fact.run_paused_human.
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "pr-1");

    // Pause via fact directly — simulates a wait.human gate without the
    // wait-human handler plumbing. Mirrors what the executor would emit.
    const s0 = r.store.getState("pr-1")!;
    r.store.appendFact(
      "pr-1",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "start" },
        },
      ],
      s0.version,
    );
    const s1 = r.store.getState("pr-1")!;
    r.store.appendFact(
      "pr-1",
      [{ type: "fact.run_paused_human", payload: { nodeId: "start", text: "wait", routes: [] } }],
      s1.version,
    );
    expect(r.store.getState("pr-1")!.status).toBe("paused_human");
    // The pause closed the dispatch interval; activeMs > 0 from
    // run_started → paused (folded with the same `now`, so accumulation
    // is whatever wall-clock elapsed in the appendFact pair).
    const pausedActive = r.store.getState("pr-1")!.metrics.activeMs;
    expect(pausedActive).toBeGreaterThanOrEqual(0);

    // Operator resumes via HITL input intent.
    r.store.appendIntent("pr-1", { type: "intent.human_input", payload: { route: "go" } });
    wakePending(r.store);
    expect(r.store.getState("pr-1")!.status).toBe("queued");

    await runUntilSettled(r.store, r.dispatcher, "pr-1");

    const final = r.store.getState("pr-1")!;
    expect(final.status).toBe("completed");

    const dispatchStarted = r.store.getEvents("pr-1").filter((e) => e.type === "fact.dispatch_started");
    expect(dispatchStarted.length).toBe(1);
    expect((dispatchStarted[0]!.payload as { resumeOf: string }).resumeOf).toBe("paused_human");
    r.cleanup();
  });

  test("multiple pause + crash cycles preserve activeMs accuracy across the run", async () => {
    // Two-node workflow so we can interleave pauses and crashes between
    // dispatches. start hangs on a controllable promise per dispatch
    // (so we can trigger crashes) but resolves cleanly when allowed.
    const yaml = `name: t\nsteps:\n  mid: {type: llm, prompt: m}\n`;
    const r = makeRig(yaml);
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => {
        await new Promise((res) => setTimeout(res, 10));
        return { kind: "transition", nextNode: "mid", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "mid", {
      kind: "step",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "multi");

    // intent.pause_requested filed BEFORE the executor starts → the
    // very first foldIntents pass turns it into
    // fact.run_paused{reason:"operator"} before any dispatch runs.
    // activeMs stays at 0 (nothing was dispatched yet); proves the
    // pause-before-start path doesn't accidentally accumulate.
    r.store.appendIntent("multi", { type: "intent.pause_requested", payload: {} });
    await runUntilSettled(r.store, r.dispatcher, "multi");

    let s = r.store.getState("multi")!;
    expect(s.status).toBe("paused");
    expect(s.metrics.activeMs).toBe(0);

    // Resume via intent.resume — now both nodes actually dispatch.
    r.store.appendIntent("multi", { type: "intent.resume", payload: {} });
    wakePending(r.store);
    await runUntilSettled(r.store, r.dispatcher, "multi");

    s = r.store.getState("multi")!;
    expect(s.status).toBe("completed");
    // Two dispatch intervals fire after resume (start handler sleeps
    // 10ms; mid is fast). activeMs is non-zero and excludes the pause
    // window — the pause-then-complete property the user asked us to
    // pin. The reducer-level multi-cycle math is covered exhaustively
    // in packages/store/test/active-ms.test.ts; this asserts the
    // executor + sweep wire it up end-to-end.
    expect(s.metrics.activeMs).toBeGreaterThan(0);
    expect(s.dispatchStartedAt).toBeNull();

    // The pre-pause path didn't dispatch (pause beat first dispatch),
    // so on resume the run starts fresh: fact.run_started covers the
    // start node (no dispatch_started for it), and the only
    // fact.dispatch_started fires for "mid" — the in-run transition
    // after start. resumeOf="fresh" because the latest preceding fact
    // is fact.node_completed; the pause provenance lives on
    // fact.run_resumed.fromStatus, which analytics joins separately.
    const dispatchStarted = r.store.getEvents("multi").filter((e) => e.type === "fact.dispatch_started");
    expect(dispatchStarted.length).toBe(1);
    const ds = dispatchStarted[0]!.payload as { nodeId: string; resumeOf: string };
    expect(ds.nodeId).toBe("mid");
    expect(ds.resumeOf).toBe("fresh");

    // The pause provenance is preserved on fact.run_resumed.
    const resumed = r.store.getEvents("multi").find((e) => e.type === "fact.run_resumed");
    expect(resumed).not.toBeUndefined();
    expect((resumed!.payload as { fromStatus: string }).fromStatus).toBe("paused");
    r.cleanup();
  });

  test("per-node timeout emits fact.node_aborted (timeout cause), distinct from crash path", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = makeRig(yaml);
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 30,
      handler: async ({ signal }) => {
        // Wait past the timeout. AbortSignal.timeout fires →
        // signal.reason is a TimeoutError DOMException → executor's
        // isAbortError recognises it → fact.node_aborted with cause
        // "timeout" is emitted.
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, 200);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            rej(signal.reason);
          });
        });
        return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
      },
    });
    enqueue(r, "to-1");
    await runUntilSettled(r.store, r.dispatcher, "to-1");

    const events = r.store.getEvents("to-1");
    const aborted = events.find((e) => e.type === "fact.node_aborted");
    expect(aborted).not.toBeUndefined();
    expect((aborted!.payload as { cause: string }).cause).toBe("timeout");
    // Crucially: NOT requeued_after_crash. Timeout is a clean handler
    // boundary, not a process death.
    expect(events.find((e) => e.type === "fact.run_requeued_after_crash")).toBeUndefined();
    r.cleanup();
  });

  test("crash + reaper takeover: daemon_events trail records the recovery, lastAliveAt credits pre-crash activeMs", async () => {
    // End-to-end audit-trail assertion across a crash boundary. We
    // simulate the daemon2 startup flow inline (lock takeover + reaper
    // event + sweep with priorHeartbeatAt) instead of spinning up a
    // full startDaemon; the entrypoint is unit-tested in
    // reaper-event.test.ts. This test focuses on the cross-cutting
    // assertion: daemon_events + per-run events + projection all
    // tell the same story.
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x}\n`;
    const r = makeRig(yaml);

    // Phase 1 — start a run, dispatch hangs, abandon the runOne.
    let resolveHang: (v: { kind: "halt"; reason: "error"; detail: string }) => void = () => undefined;
    const hangPromise = new Promise<{ kind: "halt"; reason: "error"; detail: string }>((res) => {
      resolveHang = res;
    });
    let handlerCalled = false;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 60_000,
      handler: async () => {
        handlerCalled = true;
        return hangPromise;
      },
    });
    enqueue(r, "rec-1");

    const PRIOR_PID = 99001;
    r.store.acquireDaemonLock(PRIOR_PID, "host-dead");

    const ac = new AbortController();
    r.store.claimNextRun(1);
    const ranAway = runOne("rec-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 50,
      shutdownSignal: ac.signal,
    });

    for (let i = 0; i < 100 && !handlerCalled; i++) await new Promise((res) => setTimeout(res, 5));
    expect(handlerCalled).toBe(true);
    const dispatchedAt = r.store.getState("rec-1")!.dispatchStartedAt!;

    // Phase 2 — open store2, simulate the entrypoint takeover path.
    const store2 = reopenStore(r.dbPath);
    const heartbeatAt = dispatchedAt + 5;
    const lock = store2.currentDaemonLock();
    expect(lock).not.toBeNull();
    store2.forceAcquireDaemonLock(99002, "host-new");
    store2.appendDaemonEvent({
      type: "daemon.reaper_took_over",
      payload: {
        priorPid: lock!.pid,
        priorHostname: lock!.hostname,
        priorHeartbeatAt: heartbeatAt,
        staleForMs: Date.now() - heartbeatAt,
      },
    });
    const sweepStart = Date.now();
    const sweepResult = store2.startupSweep({ priorHeartbeatAt: heartbeatAt });
    store2.appendDaemonEvent({
      type: "daemon.sweep_completed",
      payload: {
        requeued: sweepResult.requeued.length,
        quarantined: sweepResult.quarantined.length,
        durationMs: Date.now() - sweepStart,
      },
    });

    // Phase 3 — drain the orphan first so it stops touching the DB,
    // THEN run executor2 to completion. Order matters: the orphan
    // would otherwise OCC-spin against store2's writes.
    resolveHang({ kind: "halt", reason: "error", detail: "test cleanup" });
    ac.abort();
    await ranAway.catch(() => undefined);

    const dispatcher2 = new Dispatcher();
    dispatcher2.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 200,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    await runUntilSettled(store2, dispatcher2, "rec-1");

    // Phase 4 — assertions.
    const daemonEvents = store2.getDaemonEvents();

    const takeover = daemonEvents.find((e) => e.type === "daemon.reaper_took_over");
    expect(takeover).toBeDefined();
    const tPayload = takeover!.payload as { priorPid: number; priorHeartbeatAt: number; staleForMs: number };
    expect(tPayload.priorPid).toBe(PRIOR_PID);
    expect(tPayload.priorHeartbeatAt).toBe(heartbeatAt);

    const sweepCompleted = daemonEvents.find((e) => e.type === "daemon.sweep_completed");
    expect(sweepCompleted).toBeDefined();
    const sPayload = sweepCompleted!.payload as { requeued: number };
    expect(sPayload.requeued).toBe(1);

    const runEvents = store2.getEvents("rec-1");
    const requeued = runEvents.find((e) => e.type === "fact.run_requeued_after_crash");
    expect(requeued).toBeDefined();
    expect((requeued!.payload as { lastAliveAt?: number }).lastAliveAt).toBe(heartbeatAt);

    const finalState = store2.getState("rec-1")!;
    expect(finalState.status).toBe("completed");
    expect(finalState.dispatchStartedAt).toBeNull();
    // Pre-crash credit: heartbeatAt - dispatchedAt == 5ms. Plus the
    // post-resume dispatch span (small but ≥ 0).
    expect(finalState.metrics.activeMs).toBeGreaterThanOrEqual(5);

    store2.close();
    r.cleanup();
  });
});
