import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { buildSubstitutionArgs, runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

describe("buildSubstitutionArgs", () => {
  test("sets $ARGUMENTS from routing.input when it is a string", () => {
    const args = buildSubstitutionArgs("r", { input: "rename foo to bar" });
    expect(args["$ARGUMENTS"]).toBe("rename foo to bar");
  });

  test("omits $ARGUMENTS when routing.input is missing or non-string", () => {
    expect(buildSubstitutionArgs("r", {})["$ARGUMENTS"]).toBeUndefined();
    expect(buildSubstitutionArgs("r", { input: 42 })["$ARGUMENTS"]).toBeUndefined();
    expect(buildSubstitutionArgs("r", { input: null })["$ARGUMENTS"]).toBeUndefined();
  });
});

describe("executor — edge selection", () => {
  test("handler leaves nextNode unset → executor picks via condition (outcome=fail)", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      implement [shape=box];
      verify [shape=box];
      done [shape=Msquare];
      start -> implement;
      implement -> done [condition="outcome=fail"];
      implement -> verify;
      verify -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "implement", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "implement", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        tokens: 1,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "edge-1", "start");
    r.store.claimNextRun(1);
    await runOne("edge-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const events = r.store.getEvents("edge-1");
    const completedImplement = events.find(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "implement",
    );
    expect(completedImplement).not.toBeUndefined();
    expect((completedImplement!.payload as { nextNode: string }).nextNode).toBe("done");

    const edgeSelected = events.find((e) => e.type === "edge.selected");
    expect(edgeSelected).not.toBeUndefined();
    const sel = edgeSelected!.payload as { from: string; to: string; rule: string; matched_condition?: string };
    expect(sel.from).toBe("implement");
    expect(sel.to).toBe("done");
    expect(sel.rule).toBe("condition");
    expect(sel.matched_condition).toBe("outcome=fail");
    r.store.close();
  });

  test("outcome=success routes to unconditional edge, not the fail-conditioned one", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      implement [shape=box];
      verify [shape=box];
      done [shape=Msquare];
      start -> implement;
      implement -> done [condition="outcome=fail"];
      implement -> verify;
      verify -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "implement", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "implement", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "success",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "verify", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "edge-2", "start");
    r.store.claimNextRun(1);
    await runOne("edge-2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const events = r.store.getEvents("edge-2");
    const implementRow = events.find(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "implement",
    )!;
    expect((implementRow.payload as { nextNode: string }).nextNode).toBe("verify");
    r.store.close();
  });

  test("terminal reached via outcome=fail edge ends the run in 'halted' state, not 'completed'", async () => {
    // Repro of the "run claims success but nothing got done" bug the
    // quick-change workflow exhibited: implement aborts, router picks
    // the fail-conditioned edge to done (Msquare terminal). The run
    // must NOT report status=completed — the graph exited via a failure
    // branch. Mapped to UI status="fail" via mapStatus(halted).
    const dot = `digraph {
      start [shape=Mdiamond];
      implement [shape=box];
      verify [shape=box];
      done [shape=Msquare];
      start -> implement;
      implement -> done [condition="outcome=fail"];
      implement -> verify;
      verify -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "implement", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "implement", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        tokens: 1,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "halt-1", "start");
    r.store.claimNextRun(1);
    await runOne("halt-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const state = r.store.getState("halt-1")!;
    expect(state.status).toBe("halted");
    const events = r.store.getEvents("halt-1");
    const halted = events.find((e) => e.type === "fact.run_halted");
    expect(halted).not.toBeUndefined();
    const payload = halted!.payload as { reason: string; detail?: string };
    expect(payload.reason).toBe("aborted_exit");
    // Handler returned no failureReason — falls back to the generic detail.
    expect(payload.detail).toBe("reached done via outcome=fail");
    // No run_completed event should have fired — the run didn't succeed.
    expect(events.some((e) => e.type === "fact.run_completed")).toBe(false);
    r.store.close();
  });

  test("aborted_exit halt detail carries the handler's failureReason verbatim", async () => {
    // Regression for the dropped abort-reason: when an agent calls the
    // `abort` tool, findAbortToolCall → outcome.failure_reason →
    // result.failureReason → fact.run_halted.detail. Used to die at the
    // last hop because the detail was hardcoded to "reached <node> via
    // outcome=fail".
    const dot = `digraph {
      start [shape=Mdiamond];
      check [shape=box];
      done [shape=Msquare];
      start -> check;
      check -> done [condition="outcome=fail"];
      check -> done;
    }`;
    const r = rig({ dot });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "check", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "check", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        failureReason: "ABORT_NOW_PLEASE: trigger token in $ARGUMENTS",
        tokens: 1,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "halt-with-reason", "start");
    r.store.claimNextRun(1);
    await runOne("halt-with-reason", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const events = r.store.getEvents("halt-with-reason");
    const halted = events.find((e) => e.type === "fact.run_halted");
    expect(halted).not.toBeUndefined();
    const payload = halted!.payload as { reason: string; detail?: string };
    expect(payload.reason).toBe("aborted_exit");
    expect(payload.detail).toBe("ABORT_NOW_PLEASE: trigger token in $ARGUMENTS");
    r.store.close();
  });

  test("codergen fail routes through condition=outcome=fail to a recovery node (build-feature: review→fix)", async () => {
    // Regression for the handler-bridge bug that collapsed every codergen
    // fail outcome to a terminal halt — blocking review → fix recovery in
    // build-feature.dot. With the fix, fail flows through as a transition
    // and the edge selector picks the explicit fail-edge.
    const dot = `digraph {
      start [shape=Mdiamond];
      review [shape=box];
      fix [shape=box];
      verify [shape=box];
      done [shape=Msquare];
      start -> review;
      review -> fix [condition="outcome=fail", label="rejected"];
      review -> verify;
      fix -> verify;
      verify -> done;
    }`;
    const r = rig({ dot });
    let fixHandlerCalls = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "review", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "review", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        tokens: 1,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "fix", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        fixHandlerCalls++;
        return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "verify", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "rec-1", "start");
    r.store.claimNextRun(1);
    await runOne("rec-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    expect(fixHandlerCalls).toBe(1);
    const events = r.store.getEvents("rec-1");
    const reviewToFix = events.find(
      (e) =>
        e.type === "edge.selected" &&
        (e.payload as { from: string; to: string }).from === "review" &&
        (e.payload as { from: string; to: string }).to === "fix",
    );
    expect(reviewToFix).not.toBeUndefined();
    // Run finished cleanly (fix → verify → done success), not halted.
    expect(r.store.getState("rec-1")?.status).toBe("completed");
    r.store.close();
  });

  test("codergen fail with no condition=outcome=fail edge halts (no silent fallthrough)", async () => {
    // Mirrors quick-change.dot's commit/merge nodes — no fail-edge means
    // a fail outcome should halt rather than route into the unconditional
    // success edge.
    const dot = `digraph {
      start [shape=Mdiamond];
      commit [shape=box];
      merge [shape=box];
      done [shape=Msquare];
      start -> commit;
      commit -> merge;
      merge -> done;
    }`;
    const r = rig({ dot });
    let mergeHandlerCalls = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "commit", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "commit", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", outcomeStatus: "fail", tokens: 1, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "merge", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        mergeHandlerCalls++;
        return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "no-fail-edge", "start");
    r.store.claimNextRun(1);
    await runOne("no-fail-edge", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    expect(mergeHandlerCalls).toBe(0);
    expect(r.store.getState("no-fail-edge")?.status).toBe("halted");
    r.store.close();
  });

  test("diamond-shape `conditional` node routes via edge conditions (no registered handler)", async () => {
    // The auto-dispatcher's conditional case leaves nextNode unset so
    // the executor's selector picks based on state.routing. Here we seed
    // routing.approved=true and expect the edge tagged
    // `condition="context.approved = true"` to win.
    const dot = `digraph {
      start [shape=Mdiamond];
      gate [shape=diamond];
      yes [shape=box];
      no [shape=box];
      done [shape=Msquare];
      start -> gate;
      gate -> yes [condition="context.approved = true"];
      gate -> no;
      yes -> done;
      no -> done;
    }`;
    const r = rig({ dot });
    // Use the auto-dispatcher for graph-driven handlers (start, gate,
    // done) and manual register() for yes/no to keep the test terminal.
    const { autoDispatcherResolver } = await import("../src/auto-dispatcher.ts");
    r.dispatcher.setResolver(autoDispatcherResolver({ store: r.store }));
    r.dispatcher.register(r.workflowSha, "yes", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "no", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    r.store.enqueueRun({
      runId: "cond-1",
      workflowSha: r.workflowSha,
      initialRouting: { start_node: "start", approved: true },
    });
    r.store.claimNextRun(1);
    await runOne("cond-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const events = r.store.getEvents("cond-1");
    // From `gate`, the fact.node_completed should report nextNode=yes.
    const gateRow = events.find(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "gate",
    );
    expect(gateRow).not.toBeUndefined();
    expect((gateRow!.payload as { nextNode: string }).nextNode).toBe("yes");
    r.store.close();
  });

  test("handler with explicit nextNode bypasses selector (no edge.selected event)", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "edge-3", "start");
    r.store.claimNextRun(1);
    await runOne("edge-3", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
    const types = r.store.getEvents("edge-3").map((e) => e.type);
    expect(types).not.toContain("edge.selected");
    r.store.close();
  });
});

describe("executor — observability emission", () => {
  test("ctx.emit(type, data) calls land in the store as verbatim events", async () => {
    const r = rig();
    // Custom handler that emits a small agent.* trail before transitioning.
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        ctx.emit("agent.turn_start", { turnId: "t1" });
        ctx.emit("llm.text_delta", { delta: "hel" });
        ctx.emit("llm.text_delta", { delta: "lo" });
        ctx.emit("agent.message_end", { role: "assistant" });
        return { kind: "transition", nextNode: "__end__", tokens: 3, costUsd: 0 };
      },
    });
    enqueue(r, "obs-1", "start");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("obs-1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac.signal,
    });

    const types = r.store.getEvents("obs-1").map((e) => e.type);
    expect(types).toContain("agent.turn_start");
    expect(types.filter((t) => t === "llm.text_delta")).toHaveLength(2);
    expect(types).toContain("agent.message_end");
    // Observability events arrive before fact.node_completed so the UI can
    // project the conversation scoped to the node's lifetime.
    const obsIdx = types.indexOf("agent.turn_start");
    const factIdx = types.indexOf("fact.node_completed");
    expect(obsIdx).toBeGreaterThan(-1);
    expect(factIdx).toBeGreaterThan(obsIdx);
    // Each stored event carries nodeId + iteration so the UI can scope them.
    const firstObs = r.store.getEvents("obs-1").find((e) => e.type === "agent.turn_start")!;
    expect((firstObs.payload as { nodeId: string }).nodeId).toBe("start");
    expect((firstObs.payload as { iteration: number }).iteration).toBe(0);
    r.store.close();
  });

  test("emit buffer flushes even when the handler throws / aborts", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 1_000,
      handler: async (ctx) => {
        ctx.emit("llm.text_delta", { delta: "before-abort" });
        const err = new Error("cancelled");
        err.name = "AbortError";
        throw err;
      },
    });
    enqueue(r, "obs-abort", "start");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("obs-abort", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 3,
      shutdownSignal: ac.signal,
    });
    const types = r.store.getEvents("obs-abort").map((e) => e.type);
    expect(types).toContain("llm.text_delta");
    r.store.close();
  });
});

describe("executor — happy path", () => {
  test("queued → running → completed via terminal echo", async () => {
    const r = rig();
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    enqueue(r, "run1", "start");
    const claimed = r.store.claimNextRun(1)!;
    expect(claimed.runId).toBe("run1");

    const ac = new AbortController();
    await runOne("run1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac.signal,
    });

    const state = r.store.getState("run1")!;
    expect(state.status).toBe("completed");
    const events = r.store.getEvents("run1").map((e) => e.type);
    expect(events).toContain("fact.run_started");
    expect(events).toContain("fact.node_completed");
    expect(events).toContain("fact.run_completed");
    r.store.close();
  });
});

describe("executor — multi-step graph", () => {
  test("start → middle → end", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "step",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({
        kind: "transition",
        nextNode: "middle",
        tokens: 10,
        costUsd: 0.001,
        modelName: "stub-model",
      }),
    });
    r.dispatcher.register(r.workflowSha, "middle", {
      kind: "step",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({
        kind: "transition",
        nextNode: "__end__",
        tokens: 5,
        costUsd: 0.0005,
        modelName: "stub-model",
      }),
    });
    enqueue(r, "run2", "start");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("run2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: ac.signal,
    });

    const state = r.store.getState("run2")!;
    expect(state.status).toBe("completed");
    expect(state.metrics.billedTokens).toBe(15);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.0015, 6);
    expect(state.metrics.models["stub-model"]).toEqual({
      tokens: 15,
      costUsd: 0.0015,
    });
    r.store.close();
  });
});

describe("executor — HITL yield and resume", () => {
  test("yields paused_human, resumes after intent.human_input", async () => {
    const r = rig();
    r.dispatcher.register(
      r.workflowSha,
      "ask",
      handler.makeWaitHumanHandler({ options: [{ key: "O", label: "OK", to: "__end__" }] }),
    );
    enqueue(r, "run3", "ask");
    r.store.claimNextRun(1);

    const ac = new AbortController();
    const runOpts = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac.signal,
    };

    await runOne("run3", runOpts);
    let state = r.store.getState("run3")!;
    expect(state.status).toBe("paused_human");

    // Web writes the HITL input intent; wakePending sweep resurrects the run.
    r.store.appendIntent("run3", {
      type: "intent.human_input",
      payload: { route: "O" },
    });
    expect(wakePending(r.store).humanWoken).toContain("run3");
    expect(r.store.getState("run3")!.status).toBe("queued");

    r.store.claimNextRun(1);
    await runOne("run3", runOpts);
    state = r.store.getState("run3")!;
    expect(state.status).toBe("completed");
    r.store.close();
  });
});

describe("executor — cancel", () => {
  test("intent.cancel_requested terminates run", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "n", {
      kind: "noop",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({
        kind: "transition",
        nextNode: "n",
        tokens: 0,
        costUsd: 0,
      }),
    });
    enqueue(r, "run4", "n");
    r.store.appendIntent("run4", {
      type: "intent.cancel_requested",
      payload: { reason: "stop" },
    });
    r.store.claimNextRun(1);

    const ac = new AbortController();
    await runOne("run4", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac.signal,
    });
    expect(r.store.getState("run4")!.status).toBe("cancelled");
    r.store.close();
  });
});

describe("executor — allowed_tools hard filter at dispatch", () => {
  test("a handler that reaches for a non-allowed tool halts cleanly, no leaked state", async () => {
    // Node declares allowed_tools=["read"]; the handler violates the
    // contract by asking for "bash". The executor's HandlerContext
    // narrows ctx.tools via ToolRegistry.select, so ctx.tools.get("bash")
    // throws synchronously — the outer executor maps that to a
    // HandlerResult halt and appends fact.run_halted { reason: "error" }.
    const dot = `digraph {
      start [shape=Mdiamond];
      restricted [shape=box, allowed_tools="read"];
      done [shape=Msquare];
      start -> restricted;
      restricted -> done;
    }`;
    const r = rig({ dot });

    // Register the restricted tools in the registry so they exist at
    // the global level; allowed_tools is what restricts them per-node.
    r.tools.register({ name: "read", sideEffect: "none", handler: async () => undefined });
    r.tools.register({ name: "bash", sideEffect: "external", handler: async () => undefined });

    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "restricted", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "restricted", {
      kind: "codergen",
      sideEffect: "none",
      maxMs: 100,
      handler: async (ctx) => {
        // Read is fine.
        expect(() => ctx.tools.get("read")).not.toThrow();
        expect(ctx.tools.has("bash")).toBe(false);
        // Bash is not. This is what the executor must translate into a halt.
        ctx.tools.get("bash");
        // Unreachable.
        return { kind: "transition", nextNode: "done", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "rat", "start");
    r.store.claimNextRun(1);
    const ac = new AbortController();
    await runOne("rat", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: ac.signal,
    });

    const state = r.store.getState("rat")!;
    expect(state.status).toBe("halted");
    const halt = r.store.getEvents("rat").find((e) => e.type === "fact.run_halted")!;
    const payload = halt.payload as { reason: string; detail?: string };
    expect(payload.reason).toBe("error");
    expect(payload.detail).toMatch(/unknown tool: bash/);
    r.store.close();
  });
});

describe("executor — schema drift", () => {
  test("run with mismatched schema_version halts with schema_drift", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "start", {
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
    enqueue(r, "run5", "start");
    // Forcibly rewrite schema_version on the row to simulate drift.
    const db = (r.store as unknown as { db: import("bun:sqlite").Database }).db;
    db.query("UPDATE run_state SET schema_version = 999 WHERE run_id = ?").run("run5");

    r.store.claimNextRun(1);
    const ac = new AbortController();
    await runOne("run5", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 5,
      shutdownSignal: ac.signal,
    });
    const state = r.store.getState("run5")!;
    expect(state.status).toBe("halted");
    const halt = r.store.getEvents("run5").find((e) => e.type === "fact.run_halted")!;
    expect((halt.payload as { reason: string }).reason).toBe("schema_drift");
    r.store.close();
  });
});

describe("executor — provider pause and resume", () => {
  /** Run the executor's claim → dispatch loop until the run leaves the
   * `queued` state. Bounded so a runaway test fails loudly instead of
   * hanging — every step either advances or pauses. */
  async function drain(r: ReturnType<typeof rig>, runId: string, max = 12): Promise<void> {
    for (let i = 0; i < max; i++) {
      const claimed = r.store.claimNextRun(1);
      if (!claimed || claimed.runId !== runId) break;
      await runOne(runId, {
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      });
      const status = r.store.getState(runId)?.status;
      if (status !== "queued" && status !== "running") return;
    }
  }

  test("multi-step workflow: pause on step 3 → resume re-dispatches step 3 only, run completes", async () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      s1 [shape=box];
      s2 [shape=box];
      s3 [shape=box];
      done [shape=Msquare];
      start -> s1 -> s2 -> s3 -> done;
    }`;
    const r = rig({ dot });
    const calls: Array<{ nodeId: string; iteration: number }> = [];

    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "s1", tokens: 0, costUsd: 0 }),
    });
    for (const n of ["s1", "s2"] as const) {
      r.dispatcher.register(r.workflowSha, n, {
        kind: "codergen",
        sideEffect: "external",
        maxMs: 100,
        handler: async (ctx) => {
          calls.push({ nodeId: n, iteration: nodeIter(ctx) });
          return { kind: "transition", tokens: 1, costUsd: 0.001 };
        },
      });
    }
    let s3Calls = 0;
    r.dispatcher.register(r.workflowSha, "s3", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async (ctx) => {
        s3Calls++;
        calls.push({ nodeId: "s3", iteration: nodeIter(ctx) });
        if (s3Calls === 1) {
          return {
            kind: "pause_provider",
            httpStatus: 402,
            provider: "anthropic",
            errorMessage: "Insufficient balance",
          };
        }
        return { kind: "transition", tokens: 1, costUsd: 0.001 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ms-1", "start");
    await drain(r, "ms-1");

    // First drain: paused on s3.
    const pausedState = r.store.getState("ms-1")!;
    expect(pausedState.status).toBe("paused");
    expect(pausedState.currentNode).toBe("s3");

    const events = r.store.getEvents("ms-1");
    const pausedFact = events.find((e) => e.type === "fact.run_paused");
    expect(pausedFact).toBeDefined();
    const p = pausedFact!.payload as { reason: string; nodeId: string; provider: string; errorMessage: string };
    expect(p.reason).toBe("payment_required");
    expect(p.nodeId).toBe("s3");
    expect(p.provider).toBe("anthropic");
    expect(p.errorMessage).toBe("Insufficient balance");

    // Each prior step ran exactly once before s3 paused.
    const callCount = (n: string): number => calls.filter((c) => c.nodeId === n).length;
    expect(callCount("s1")).toBe(1);
    expect(callCount("s2")).toBe(1);
    expect(callCount("s3")).toBe(1);

    // Operator resume: write intent.resume; wakePending advances to queued.
    r.store.appendIntent("ms-1", { type: "intent.resume", payload: { note: "topped up" } });
    const wake = wakePending(r.store);
    expect(wake.resumed).toContain("ms-1");
    expect(r.store.getState("ms-1")!.status).toBe("queued");
    const resumedFact = r.store.getEvents("ms-1").find((e) => e.type === "fact.run_resumed");
    expect(resumedFact).toBeDefined();
    const rf = resumedFact!.payload as { fromStatus: string };
    expect(rf.fromStatus).toBe("paused");

    // Drain again: re-dispatches s3 (only), completes.
    await drain(r, "ms-1");
    expect(r.store.getState("ms-1")!.status).toBe("completed");
    expect(callCount("s1")).toBe(1); // not re-run
    expect(callCount("s2")).toBe(1); // not re-run
    expect(callCount("s3")).toBe(2); // ran again on resume
    // Iteration stays 0 for s3 across the two calls — provider pause is
    // not a backward-edge re-entry, so retry_count never bumps.
    const s3IterAfterResume = calls.filter((c) => c.nodeId === "s3").map((c) => c.iteration);
    expect(s3IterAfterResume).toEqual([0, 0]);

    r.store.close();
  });

  test("messages persisted on prior steps survive the pause and stay scoped to their node", async () => {
    // Same shape as above, but s1 + s2 each persist a message via
    // ctx.messages.append. After pause+resume, the stored transcript
    // still contains s1's and s2's messages tagged with their node ids,
    // and the executor never appends a duplicate s3 entry on the second
    // dispatch (s3 doesn't write any messages here — the assertion is
    // that the prior nodes' messages are preserved, scoped, and not
    // mixed into s3's scope).
    const dot = `digraph {
      start [shape=Mdiamond];
      s1 [shape=box];
      s2 [shape=box];
      s3 [shape=box];
      done [shape=Msquare];
      start -> s1 -> s2 -> s3 -> done;
    }`;
    const r = rig({ dot });

    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "s1", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "s1", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async (ctx) => {
        ctx.messages.append({
          role: "assistant",
          content: [{ type: "text", text: "step1 output" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "stub",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        });
        return { kind: "transition", tokens: 1, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "s2", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async (ctx) => {
        ctx.messages.append({
          role: "assistant",
          content: [{ type: "text", text: "step2 output" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "stub",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        });
        return { kind: "transition", tokens: 1, costUsd: 0 };
      },
    });
    let s3Calls = 0;
    r.dispatcher.register(r.workflowSha, "s3", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        s3Calls++;
        if (s3Calls === 1) {
          return {
            kind: "pause_provider",
            httpStatus: 402,
            provider: "anthropic",
            errorMessage: "Insufficient balance",
          };
        }
        return { kind: "transition", tokens: 1, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ms-2", "start");
    await drain(r, "ms-2");
    expect(r.store.getState("ms-2")!.status).toBe("paused");

    // Snapshot messages at pause time. Both s1 and s2 wrote one each;
    // s3 wrote zero (it paused before producing anything).
    const beforeResume = r.store.getMessages("ms-2");
    const byNodeBefore = beforeResume.reduce<Record<string, number>>((acc, m) => {
      const n = m.nodeId ?? "<none>";
      acc[n] = (acc[n] ?? 0) + 1;
      return acc;
    }, {});
    expect(byNodeBefore["s1"]).toBe(1);
    expect(byNodeBefore["s2"]).toBe(1);
    expect(byNodeBefore["s3"]).toBeUndefined();

    // Resume.
    r.store.appendIntent("ms-2", { type: "intent.resume", payload: {} });
    wakePending(r.store);
    await drain(r, "ms-2");
    expect(r.store.getState("ms-2")!.status).toBe("completed");

    // Post-resume: prior nodes' messages survive, still scoped to their
    // node ids. No duplicates were minted on the resumed dispatch.
    const afterResume = r.store.getMessages("ms-2");
    const byNodeAfter = afterResume.reduce<Record<string, number>>((acc, m) => {
      const n = m.nodeId ?? "<none>";
      acc[n] = (acc[n] ?? 0) + 1;
      return acc;
    }, {});
    expect(byNodeAfter["s1"]).toBe(1);
    expect(byNodeAfter["s2"]).toBe(1);
    // s3 still wrote zero on its second call — assertion is that no
    // foreign-node messages got laundered onto its scope.
    expect(byNodeAfter["s3"]).toBeUndefined();

    // The s1 + s2 message contents are untouched.
    const s1msg = afterResume.find((m) => m.nodeId === "s1")!;
    expect(JSON.stringify(s1msg.content)).toContain("step1 output");
    const s2msg = afterResume.find((m) => m.nodeId === "s2")!;
    expect(JSON.stringify(s2msg.content)).toContain("step2 output");

    r.store.close();
  });
});

/** Read the per-node retry counter that result-to-facts uses for
 * iteration tagging. Mirrors the live `routing.retry_count` lookup. */
function nodeIter(ctx: handler.HandlerContext): number {
  const v = (ctx as unknown as { routing: Record<string, unknown> }).routing?.["retry_count"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
