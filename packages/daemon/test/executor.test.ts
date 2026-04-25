import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { buildSubstitutionArgs, runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

describe("buildSubstitutionArgs", () => {
  test("always sets $RUN_ID from the runId", () => {
    const args = buildSubstitutionArgs("run-xyz", {});
    expect(args["$RUN_ID"]).toBe("run-xyz");
  });

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
    // No run_completed event should have fired — the run didn't succeed.
    expect(events.some((e) => e.type === "fact.run_completed")).toBe(false);
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
    expect(state.metrics.totalTokens).toBe(15);
    expect(state.metrics.totalCostUsd).toBeCloseTo(0.0015, 6);
    expect(state.metrics.models["stub-model"]).toEqual({
      tokens: 15,
      costUsd: 0.0015,
    });
    r.store.close();
  });
});

describe("executor — HITL yield and resume", () => {
  test("yields paused_hitl, resumes after intent.hitl_input", async () => {
    const r = rig();
    r.dispatcher.register(r.workflowSha, "ask", handler.makeWaitHumanHandler({ prompt: "ok?", nextNode: "__end__" }));
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
    expect(state.status).toBe("paused_hitl");

    // Web writes the HITL input intent; wakePending sweep resurrects the run.
    r.store.appendIntent("run3", {
      type: "intent.hitl_input",
      payload: { input: "approved" },
    });
    expect(wakePending(r.store).hitlWoken).toContain("run3");
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
