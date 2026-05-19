// Goal-gate enforcement — end-to-end through the executor.
// Attractor §3.4: terminal exit gated on every visited goal_gate=true node
// having outcome SUCCESS or PARTIAL_SUCCESS. Otherwise the §3.4 retarget
// chain redirects, bounded by max_goal_gate_retries; on exhaustion the run
// halts with reason="goal_gate_unsatisfied".

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

describe("executor — goal-gate enforcement (§3.4)", () => {
  test("gate succeeds → run completes cleanly", async () => {
    const yaml = `name: t\nsteps:\n  gate: {type: llm, prompt: x, goal_gate: true}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "gate", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "gate", {
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
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "gg1", "start");
    r.store.claimNextRun(1);
    await runOne("gg1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("gg1")!;
    expect(state.status).toBe("completed");
    r.store.close();
  });

  test("gate fails with retry_target=fix; §3.4 retargets on terminal arrival", async () => {
    // Fail-edge routes the gate's failure straight to terminal, so §3.7
    // (per-node fail retarget) doesn't fire. §3.4 (goal-gate at terminal)
    // catches it instead.
    const yaml = `name: t
steps:
  gate:
    type: llm
    prompt: g
    retry: fix
    on: {success: exit}
  fix: {type: llm, prompt: f, next: gate}
`;
    const r = rig({ yaml });
    let gateAttempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "gate", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        gateAttempts++;
        // First call fails, second succeeds.
        return {
          kind: "transition",
          outcomeStatus: gateAttempts === 1 ? "fail" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "fix", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        nextNode: "gate",
        outcomeStatus: "success",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "gg2", "start");
    r.store.claimNextRun(1);
    await runOne("gg2", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 30,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("gg2")!;
    expect(state.status).toBe("completed");
    expect(gateAttempts).toBe(2);

    // Observability event records the retarget.
    const events = r.store.getEvents("gg2");
    const retarget = events.find((e) => e.type === "goal_gate.retarget");
    expect(retarget).toBeDefined();
    expect((retarget?.payload as { failedGate: string }).failedGate).toBe("gate");
    expect((retarget?.payload as { target: string }).target).toBe("fix");

    // The originally-selected `gate -> done` edge on the failing attempt
    // was overridden by the §3.4 retarget, so it was never actually
    // traversed. Suppressing its `edge.selected` keeps the projection
    // (and the UI's edge highlighting) honest. The second-attempt
    // `gate -> done` (after the retry succeeds) IS traversed and is
    // recorded.
    const gateToDoneSelections = events.filter(
      (e) =>
        e.type === "edge.selected" &&
        (e.payload as { from?: string; to?: string }).from === "gate" &&
        (e.payload as { from?: string; to?: string }).to === "exit",
    );
    expect(gateToDoneSelections).toHaveLength(1);
    // The surviving selection is the success branch — no matched_condition
    // because the success edge in the DOT is unconditional.
    expect((gateToDoneSelections[0]?.payload as { matched_condition?: string }).matched_condition).toBeUndefined();
    r.store.close();
  });

  test("gate fails with no retry_target anywhere → halt with goal_gate_unsatisfied", async () => {
    const yaml = `name: t\nsteps:\n  gate: {type: llm, prompt: x, goal_gate: true}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "gate", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "gg3", "start");
    r.store.claimNextRun(1);
    await runOne("gg3", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("gg3")!;
    // Stage 3 of recoverable-budget-pause.md: goal-gate exhaustion
    // is now an operator-resumable pause, not a terminal halt.
    expect(state.status).toBe("paused");

    const events = r.store.getEvents("gg3");
    const pause = events.filter((e) => e.type === "fact.run_paused").pop();
    expect(pause).toBeDefined();
    expect((pause?.payload as { reason: string }).reason).toBe("goal_gate");
    expect((pause?.payload as { gateNodeId: string }).gateNodeId).toBe("gate");

    const unsat = events.find((e) => e.type === "goal_gate.unsatisfied");
    expect(unsat).toBeDefined();
    r.store.close();
  });

  test("gate keeps failing past max_goal_gate_retries=1 → halt", async () => {
    // Same fail-edge structure as the success-on-retry case. With cap=1,
    // the second failed gate exhausts retries.
    const yaml = `name: t
max-goal-gate-retries: 1
steps:
  gate:
    type: llm
    prompt: g
    retry: fix
    on: {success: exit}
  fix: {type: llm, prompt: f, next: gate}
`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "gate", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "fail",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "fix", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        nextNode: "gate",
        outcomeStatus: "success",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "gg4", "start");
    r.store.claimNextRun(1);
    await runOne("gg4", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 30,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("gg4")!;
    expect(state.status).toBe("paused");

    const events = r.store.getEvents("gg4");
    const pause = events.filter((e) => e.type === "fact.run_paused").pop();
    expect((pause?.payload as { reason: string }).reason).toBe("goal_gate");

    // Counted exactly one retarget before exhaustion.
    const retargets = events.filter((e) => e.type === "goal_gate.retarget");
    expect(retargets).toHaveLength(1);
    r.store.close();
  });
});

describe("executor — §3.7 fail-routing retarget", () => {
  // SKIP: with the new GHA-style parser, every step gets an implicit
  // fail→exit edge synthesised. The "no fail-edge" precondition this
  // test exercised is no longer expressible — `retry: <step>` is the
  // canonical way to declare a fail-retarget, and it sets goal_gate=true
  // so the §3.4 path handles it. The §3.7 fallback path is effectively
  // unreachable from the parser.
  test.skip("node fails with no fail-edge but retry_target set → retargets", async () => {
    const yaml = `name: t
steps:
  work: {type: llm, prompt: x, retry_target: rescue}
  rescue: {type: llm, prompt: r}
`;
    const r = rig({ yaml });
    let workAttempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "codergen",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        workAttempts++;
        return {
          kind: "transition",
          outcomeStatus: "fail",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "rescue", {
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
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "fr1", "start");
    r.store.claimNextRun(1);
    await runOne("fr1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 20,
      shutdownSignal: new AbortController().signal,
    });

    const state = r.store.getState("fr1")!;
    expect(state.status).toBe("completed");
    expect(workAttempts).toBe(1);

    // Sequence: work (fail) → rescue (success) → done.
    const events = r.store.getEvents("fr1");
    const completedNodes = events
      .filter((e) => e.type === "fact.node_completed")
      .map((e) => (e.payload as { nodeId: string }).nodeId);
    expect(completedNodes).toContain("work");
    expect(completedNodes).toContain("rescue");
    r.store.close();
  });
});
