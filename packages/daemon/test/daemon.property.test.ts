// Daemon-level property tests — ARCHITECTURE.md §10.
//
//  P3  intents never lost
//  P5  startup sweep requeues running runs
//  P9  daemon singleton
//  P10 concurrency cap honored
//  P11 HITL durability across a simulated crash
//  P21 queue fairness — claim order = commit order of HITL wake within priority tier

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { SqliteStore } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { AbortRegistry } from "../src/abort-registry.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { DaemonAlreadyRunningError, startDaemon } from "../src/entrypoint.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) {
    const c = closers.pop();
    try {
      c?.();
    } catch {}
  }
});

describe("P3 — intents never lost", () => {
  test("random intents submitted during run remain visible in the event log", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("pause", "steer", "steer", "hitl", "priority"), { minLength: 1, maxLength: 8 }),
        async (kinds) => {
          const r = rig();
          closers.push(() => r.store.close());
          r.dispatcher.register(r.workflowSha, "n", {
            kind: "noop",
            sideEffect: "none",
            maxMs: 1_000,
            handler: async () => ({
              kind: "transition",
              nextNode: "__end__",
              tokens: 0,
              costUsd: 0,
            }),
          });
          enqueue(r, "rp3", "n");

          for (const k of kinds) {
            switch (k) {
              case "pause":
                r.store.appendIntent("rp3", {
                  type: "intent.pause_requested",
                  payload: {},
                });
                break;
              case "steer":
                r.store.appendIntent("rp3", {
                  type: "intent.steering_requested",
                  payload: { text: "go" },
                });
                break;
              case "hitl":
                r.store.appendIntent("rp3", {
                  type: "intent.human_input",
                  payload: { route: "A" },
                });
                break;
              case "priority":
                r.store.appendIntent("rp3", {
                  type: "intent.priority_adjusted",
                  payload: { newPriority: 5, note: "bump" },
                });
                break;
            }
          }

          const events = r.store
            .getEvents("rp3")
            .filter((e) => e.writer === "client" && e.type !== "intent.run_enqueued");
          expect(events).toHaveLength(kinds.length);
        },
      ),
      { numRuns: pbtRuns(15) },
    );
  });
});

// invariant: P5 — crash recovery requeue: running → queued on the startup
// sweep. Load-bearing sentinel for invariant-coverage.test.ts.
describe("P5 — startup sweep requeues running runs", () => {
  test("a run in 'running' state is moved back to 'queued' by sweep", () => {
    const r = rig();
    closers.push(() => r.store.close());
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "rp5", "start");
    r.store.claimNextRun(1); // now running, but we kill "mid-flight"
    expect(r.store.getState("rp5")!.status).toBe("running");

    const sweep = r.store.startupSweep();
    expect(sweep.requeued).toContain("rp5");
    expect(r.store.getState("rp5")!.status).toBe("queued");
  });
});

describe("startDaemon — maxLoops plumbed through to executor", () => {
  test("maxLoops forwarded from DaemonMainOpts → runExecutor halts a looping run", async () => {
    const r = rig();
    closers.push(() => r.store.close());
    // Self-looping handler: every dispatch transitions back to "start".
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "start", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rml", "start");

    const shutdown = new AbortController();
    const handle = startDaemon({
      store: r.store,
      dispatcher: r.dispatcher,
      tools: r.tools,
      llmCall: r.llmCall,
      pid: 9911,
      hostname: "hostMaxLoops",
      maxConcurrentRuns: 1,
      maxLoops: 2,
      shutdownSignal: shutdown.signal,
    });

    // Poll the run state; pause should fire within a handful of ticks.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const s = r.store.getState("rml");
      if (s?.status === "paused") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    shutdown.abort();
    await handle.done.catch(() => undefined);

    const final = r.store.getState("rml")!;
    // Stage 3 of recoverable-budget-pause.md: max_loops is now an
    // operator-resumable pause, not a terminal halt.
    expect(final.status).toBe("paused");
    const pause = r.store
      .getEvents("rml")
      .filter((e) => e.type === "fact.run_paused")
      .pop()!;
    expect((pause.payload as { reason: string }).reason).toBe("max_loops");
  });
});

describe("P9 — daemon singleton", () => {
  test("a second daemon with a fresh heartbeat is refused", async () => {
    const r = rig();
    closers.push(() => r.store.close());
    r.store.acquireDaemonLock(1111, "hostA");

    const handle = startDaemon({
      store: r.store,
      dispatcher: r.dispatcher,
      tools: r.tools,
      llmCall: r.llmCall,
      pid: 2222,
      hostname: "hostB",
      maxConcurrentRuns: 1,
      lockTtlMs: 60_000,
    });
    await expect(handle.done).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    // Clean up: nothing else to do, lock still held by 1111.
  });
});

describe("P10 — concurrency cap honored", () => {
  test("claimNextRun never returns more than MAX concurrent running runs", () => {
    const r = rig();
    closers.push(() => r.store.close());
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    for (let i = 0; i < 10; i++) {
      enqueue(r, `c_${i}`, "start");
    }
    const MAX = 3;
    const claimed: string[] = [];
    for (let i = 0; i < 10; i++) {
      const c = r.store.claimNextRun(MAX);
      if (c != null) claimed.push(c.runId);
    }
    expect(claimed).toHaveLength(MAX);
  });
});

describe("P11 — HITL durability across simulated crash", () => {
  test("paused_human run survives a full store reopen (in-memory: sim via two SqliteStore instances on same file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-hitl-"));
    const dbPath = join(dir, "fragua.db");

    // Phase 1: open, pause at HITL.
    const s1 = new SqliteStore({ path: dbPath });
    s1.saveWorkflow(
      "wf",
      "t",
      "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
      serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
      CURRENT_IR_VERSION,
    );
    const dispatcher = new Dispatcher();
    dispatcher.register(
      "wf",
      "ask",
      handler.makeHumanHandler({ nodeId: "ask", text: "wait", routes: ["O"], edges: [{ route: "O", to: "__end__" }] }),
    );
    const tools = new handler.InMemoryToolRegistry();
    const llmCall: handler.LlmCallFn = async () => ({
      content: "",
      tokens: 0,
      costUsd: 0,
      model: "stub",
    });
    s1.enqueueRun({
      runId: "rp11",
      workflowSha: "wf",
      initialRouting: { start_node: "ask" },
    });
    s1.claimNextRun(1);
    const ac1 = new AbortController();
    await runOne("rp11", {
      store: s1,
      dispatcher,
      registry: new AbortRegistry(),
      tools,
      llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac1.signal,
    });
    expect(s1.getState("rp11")!.status).toBe("paused_human");
    s1.appendIntent("rp11", {
      type: "intent.human_input",
      payload: { route: "O" },
    });
    s1.close();

    // Phase 2: reopen, resume, finish.
    const s2 = new SqliteStore({ path: dbPath });
    expect(s2.getState("rp11")!.status).toBe("paused_human");
    wakePending(s2);
    expect(s2.getState("rp11")!.status).toBe("queued");
    s2.claimNextRun(1);
    const ac2 = new AbortController();
    await runOne("rp11", {
      store: s2,
      dispatcher,
      registry: new AbortRegistry(),
      tools,
      llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac2.signal,
    });
    expect(s2.getState("rp11")!.status).toBe("completed");
    s2.close();
  });
});

describe("P21 — queue fairness on simultaneous HITL wake", () => {
  test("when N runs wake via HITL back to back, claim order matches wake order", async () => {
    const r = rig();
    closers.push(() => r.store.close());
    r.dispatcher.register(
      r.workflowSha,
      "ask",
      handler.makeHumanHandler({ nodeId: "ask", text: "wait", routes: ["O"], edges: [{ route: "O", to: "__end__" }] }),
    );

    // Prime: three runs all pause at HITL.
    const ids = ["q1", "q2", "q3"];
    for (const id of ids) {
      enqueue(r, id, "ask", 10);
      r.store.claimNextRun(10);
      const ac = new AbortController();
      await runOne(id, {
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 10,
        maxTurnsForTesting: 5,
        shutdownSignal: ac.signal,
      });
    }
    for (const id of ids) {
      expect(r.store.getState(id)!.status).toBe("paused_human");
    }

    // All three get HITL input in order q1, q2, q3.
    for (const id of ids) {
      r.store.appendIntent(id, {
        type: "intent.human_input",
        payload: { route: "O" },
      });
    }
    wakePending(r.store);

    // Claim order should respect ready_at ASC within the priority-10 tier.
    // wakePending iterates rows in SQLite scan order; within a single
    // transaction each run_resumed advances its own ready_at one microsecond
    // after the previous (the store increments its clock for each now()).
    const order: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const c = r.store.claimNextRun(10);
      if (c != null) order.push(c.runId);
    }
    expect(new Set(order)).toEqual(new Set(ids));
    // Ordering determinism: the wake order should match the claim order.
    expect(order).toEqual(ids);
  });
});
