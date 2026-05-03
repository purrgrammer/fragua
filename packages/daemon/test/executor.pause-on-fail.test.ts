// Mid-dispatch pause — operator clicks Pause while a codergen handler
// is mid-stream. The supervisor trips the abort signal; the agent
// rethrows AbortError instead of converting to a fail outcome (see
// packages/agent/src/backend.ts). The executor's existing wasAborted
// path then writes fact.node_aborted only — the run stays running —
// and the next dispatch's fold consumes the pause intent through the
// normal R4 path, producing fact.run_paused with reason=operator.
//
// This test stubs the codergen with a hand-rolled handler that throws
// AbortError when its signal is tripped. It does NOT exercise the
// pi-ai integration directly; that's covered by the agent unit suite.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

describe("executor — pause mid-dispatch routes through abort-throw + next-fold", () => {
  test("handler throws AbortError when signal trips → run_paused (operator), not halted", async () => {
    const r = rig({
      dot: `digraph {
        start [shape=Mdiamond];
        impl  [shape=box];
        done  [shape=Msquare];
        start -> impl;
        impl -> done;
      }`,
    });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "impl", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "impl", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async (ctx) => {
        // Mirror the agent boundary: append the pause intent inside the
        // handler (same race shape as the supervisor tripping mid-stream),
        // wait briefly for it to land, then throw AbortError if the
        // executor's abort plumbing fires. Otherwise return success — the
        // test asserts the abort path was taken, not the success path.
        const dbHandle = (r.store as unknown as { db: { query: (sql: string) => { all: () => { run_id: string }[] } } })
          .db;
        const runs = dbHandle.query("SELECT run_id FROM run_state WHERE status='running'").all();
        const runId = runs[0]?.run_id;
        if (runId) r.store.appendIntent(runId, { type: "intent.pause_requested", payload: {} });
        // Wait one tick so a real supervisor would pick up the intent.
        // Without a real supervisor, simulate the trip directly via the
        // registry so the executor's wasAborted path runs.
        await new Promise((res) => setTimeout(res, 0));
        if (ctx.signal.aborted) {
          const err = new Error("signal aborted");
          err.name = "AbortError";
          throw err;
        }
        return { kind: "transition", outcomeStatus: "fail", tokens: 0, costUsd: 0 };
      },
    });
    registerTerminalEcho(r.dispatcher, r.workflowSha, "done");

    enqueue(r, "mid-pause", "start");
    r.store.claimNextRun(1);

    // Trip the run's controller a few ms in — same shape as the supervisor.
    const reg = new AbortRegistry();
    setTimeout(() => reg.trip("mid-pause"), 1);

    await runOne("mid-pause", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: reg,
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("mid-pause");
    // The abort path emits fact.node_aborted; the next dispatch's fold
    // turns the pending pause intent into fact.run_paused with reason=operator.
    expect(events.some((e) => e.type === "fact.node_aborted")).toBe(true);
    const pauseFacts = events.filter((e) => e.type === "fact.run_paused");
    expect(pauseFacts.length).toBe(1);
    expect((pauseFacts[0]!.payload as { reason: string }).reason).toBe("operator");
    expect(events.filter((e) => e.type === "fact.run_halted").length).toBe(0);
    expect(r.store.getState("mid-pause")?.status).toBe("paused");
  });
});
