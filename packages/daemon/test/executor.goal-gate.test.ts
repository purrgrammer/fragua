// Goal-gate enforcement — end-to-end through the executor.
// Attractor §3.4: terminal exit gated on every visited goal_gate=true node
// having outcome SUCCESS or PARTIAL_SUCCESS. Otherwise the §3.4 retarget
// chain redirects, bounded by the failing gate's own max_retries; on
// exhaustion the run pauses with reason="goal_gate".

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

async function driveOnce(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 30,
    shutdownSignal: new AbortController().signal,
  });
}

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
      kind: "llm",
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
    // catches it instead. max-retries:2 satisfies the E031 requirement.
    const yaml = `name: t
steps:
  gate:
    type: llm
    prompt: g
    retry: fix
    max-retries: 2
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
      kind: "llm",
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
      kind: "llm",
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
    // because the success edge is unconditional.
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
      kind: "llm",
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

  test("gate keeps failing past its own max-retries cap → pause goal_gate", async () => {
    // Same fail-edge structure as the success-on-retry case. With cap=1
    // on the gate itself, the second failed gate exhausts retries.
    const yaml = `name: t
steps:
  gate:
    type: llm
    prompt: g
    retry: fix
    max-retries: 1
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
      kind: "llm",
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
      kind: "llm",
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
      kind: "llm",
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
      kind: "llm",
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

describe("executor — non-gate fail does not retarget a previously-failed gate", () => {
  // Regression for the propose-step abort loop observed on run
  // 01kspxc14ktygz3grtevey53kp (audit optimize). Once a gate has failed
  // and its outcome lives in routing state, a later *non-gate* node
  // terminating via `outcome=fail` (the abort tool's map, or any
  // unrecovered failure) was being intercepted by the §3.4 terminal-arrival
  // check, which retargeted the gate's `retry_target` (often the failing
  // node itself). The carve-out in transition-planner skips the gate
  // check on a non-gate fail so the run halts cleanly per the documented
  // `aborted_exit` semantics (see `agent/backend.ts:findAbortToolCall`).
  test("propose fails after gate-pause + resume → halts, does not loop on retarget", async () => {
    // Topology: propose → reeval → gate (retry: propose). Gate fails
    // every time. After exhausting max-retries=1 it pauses goal_gate.
    // Operator raises the cap and resumes; propose now also fails
    // (simulating abort because nothing more can be tried). Without the
    // carve-out, the §3.4 check at propose's terminal arrival would
    // retarget back to propose because the gate is still unsatisfied,
    // looping until the raised cap exhausts. With the fix, propose's
    // fail terminates via the standard halt path.
    const yaml = `name: t
steps:
  propose:
    type: llm
    prompt: p
    next: reeval
  reeval:
    type: llm
    prompt: r
    next: gate
  gate:
    type: llm
    prompt: g
    retry: propose
    max-retries: 1
    on: {success: exit}
`;
    const r = rig({ yaml });
    let proposeAttempts = 0;
    let gateAttempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "propose", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "propose", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        proposeAttempts++;
        // First two attempts succeed (before pause). Third — the post-resume
        // attempt — fails, simulating the propose-step's `abort` after the
        // operator raised the cap.
        return {
          kind: "transition",
          outcomeStatus: proposeAttempts >= 3 ? "fail" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "reeval", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({
        kind: "transition",
        outcomeStatus: "success",
        tokens: 0,
        costUsd: 0,
      }),
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        gateAttempts++;
        return { kind: "transition", outcomeStatus: "fail", tokens: 0, costUsd: 0 };
      },
    });

    enqueue(r, "ng1", "start");
    // First drive: gate fails twice (max-retries=1 → one retarget, then
    // pause on the second failure). propose ran twice (once initially,
    // once on the retarget).
    await driveOnce(r, "ng1");
    expect(r.store.getState("ng1")!.status).toBe("paused");
    expect(gateAttempts).toBe(2);
    expect(proposeAttempts).toBe(2);

    // Operator raises the cap and resumes. The resume re-dispatches the
    // paused node (gate) once with the new cap; gate fails again, the
    // engine retargets to propose, propose fails, halt.
    r.store.appendIntent("ng1", { type: "intent.goal_gate_adjusted", payload: { newLimit: 5 } });
    r.store.appendIntent("ng1", { type: "intent.resume", payload: {} });
    expect(wakePending(r.store).resumed).toContain("ng1");

    await driveOnce(r, "ng1");

    const state = r.store.getState("ng1")!;
    expect(state.status).toBe("halted");

    // Post-resume sequence (with the fix): gate re-runs once (re-dispatch
    // on resume), retargets to propose under the raised cap, propose runs
    // once and returns fail, fail lands at the terminal and halts.
    // Without the fix, propose's fail would be intercepted by the §3.4
    // terminal check (gate still unsatisfied) and re-routed back to
    // propose, looping until the raised cap (5) exhausts — proposeAttempts
    // would balloon to 6+ and gateAttempts would track the inner re-runs.
    expect(gateAttempts).toBe(3);
    expect(proposeAttempts).toBe(3);

    const events = r.store.getEvents("ng1");
    const haltEvent = events.find((e) => e.type === "fact.run_halted");
    expect(haltEvent).toBeDefined();
    // Halt reason is the standard non-gate-fail terminal landing — NOT
    // goal_gate_unsatisfied.
    expect((haltEvent?.payload as { reason: string }).reason).toBe("aborted_exit");

    // Exactly two retargets total: one pre-pause (first gate fail), and
    // one post-resume (raised-cap re-decision). No extra retargets fired
    // from propose's own fail.
    const retargets = events.filter((e) => e.type === "goal_gate.retarget");
    expect(retargets).toHaveLength(2);

    // Final propose completion routed to a terminal, not back to propose
    // itself. (This is the assertion that would FAIL without the carve-out
    // — the bug rewrote `nextNode` to propose, looping.)
    const proposeCompletions = events.filter(
      (e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "propose",
    );
    const lastPropose = proposeCompletions[proposeCompletions.length - 1];
    expect((lastPropose?.payload as { outcomeStatus: string }).outcomeStatus).toBe("fail");
    expect((lastPropose?.payload as { nextNode: string }).nextNode).toBe("__end__");
    r.store.close();
  });

  test("non-gate fail with explicit `on: {fail: exit}` + prior failed gate → completes", async () => {
    // Companion to the loop regression above. Workflows skill: "an explicit
    // edge to the `exit` sink on failure (`on: {fail: exit}`) is a sanctioned
    // landing — the run *completes*. Use it only when 'failed here is a fine
    // end state'." The same carve-out that prevents the abort-loop also
    // honors this documented escape hatch: before the fix, the §3.4 check
    // at terminal arrival would silently override the explicit fail-edge
    // and retarget back through the gate's retry_target.
    const yaml = `name: t
steps:
  propose:
    type: llm
    prompt: p
    on: {success: gate, fail: exit}
  gate:
    type: llm
    prompt: g
    retry: propose
    max-retries: 1
    on: {success: exit}
`;
    const r = rig({ yaml });
    let proposeAttempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "propose", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "propose", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        proposeAttempts++;
        // First call → success (drives the gate cycle). Second call (after
        // the gate's retarget) → fail, taking the explicit `on: {fail: exit}`.
        return {
          kind: "transition",
          outcomeStatus: proposeAttempts >= 2 ? "fail" : "success",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => ({ kind: "transition", outcomeStatus: "fail", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "ng2", "start");
    await driveOnce(r, "ng2");

    const state = r.store.getState("ng2")!;
    // With the fix: propose's explicit fail edge to `exit` lands cleanly
    // and the run completes. Without the fix, the §3.4 check at the
    // `exit` terminal would override `nextNode` back to propose and loop
    // until the gate's max-retries (=1) re-exhausts, pausing.
    expect(state.status).toBe("completed");

    const events = r.store.getEvents("ng2");
    const lastPropose = events
      .filter((e) => e.type === "fact.node_completed" && (e.payload as { nodeId: string }).nodeId === "propose")
      .pop();
    expect((lastPropose?.payload as { outcomeStatus: string }).outcomeStatus).toBe("fail");
    expect((lastPropose?.payload as { nextNode: string }).nextNode).toBe("exit");
    r.store.close();
  });
});

describe("executor — operator goal_gate_adjusted override", () => {
  test("intent.goal_gate_adjusted raises the gate cap above its max-retries", async () => {
    // Gate has max-retries: 1. After the first retarget it pauses with
    // reason=goal_gate. Operator injects goal_gate_adjusted{newLimit:3} +
    // resume. The run retargets twice more (total 3) before the gate finally
    // succeeds, confirming the operator lever survives the refactor.
    const yaml = `name: t
steps:
  gate:
    type: llm
    prompt: g
    retry: fix
    max-retries: 1
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
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        gateAttempts++;
        // Succeed on attempt 4 (after 3 retargets with raised cap).
        return {
          kind: "transition",
          outcomeStatus: gateAttempts >= 4 ? "success" : "fail",
          tokens: 0,
          costUsd: 0,
        };
      },
    });
    r.dispatcher.register(r.workflowSha, "fix", {
      kind: "llm",
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

    enqueue(r, "gg-ov", "start");
    // First drive: gate fails twice, pauses at max-retries=1.
    await driveOnce(r, "gg-ov");
    expect(r.store.getState("gg-ov")!.status).toBe("paused");
    const pauseReason = r.store
      .getEvents("gg-ov")
      .filter((e) => e.type === "fact.run_paused")
      .pop();
    expect((pauseReason?.payload as { reason: string }).reason).toBe("goal_gate");

    // Operator raises the cap and resumes.
    r.store.appendIntent("gg-ov", { type: "intent.goal_gate_adjusted", payload: { newLimit: 3 } });
    r.store.appendIntent("gg-ov", { type: "intent.resume", payload: {} });
    const wake = wakePending(r.store);
    expect(wake.resumed).toContain("gg-ov");

    // Second drive: override allows retargets 2 and 3; gate succeeds on attempt 4.
    await driveOnce(r, "gg-ov");
    expect(r.store.getState("gg-ov")!.status).toBe("completed");
    expect(gateAttempts).toBe(4);
    r.store.close();
  });
});
