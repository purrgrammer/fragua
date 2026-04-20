import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { buildSubstitutionArgs, runOne } from "../src/executor.ts";
import { wakePendingHitl } from "../src/wake-hitl.ts";
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

    // Web writes the HITL input intent; wake-hitl sweep resurrects the run.
    r.store.appendIntent("run3", {
      type: "intent.hitl_input",
      payload: { input: "approved" },
    });
    expect(wakePendingHitl(r.store)).toContain("run3");
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
