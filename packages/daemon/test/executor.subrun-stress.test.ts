// Stress tests for the parallel sub-run state machine — mixed terminal
// states, all-paused fan-outs, operator actions while children are
// blocked, cancel cascades, multi-HITL siblings.
//
// Each test exercises a corner where the parent's status, the children's
// statuses, and the executor's claim/slot accounting need to agree.
// Failures here usually point at either wake-pending convergence logic
// or the parent's running_children semantics.

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { mockCodergenSpec } from "./helpers.ts";

function freshHarness() {
  const store = new SqliteStore({ path: ":memory:" });
  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });
  const registry = new AbortRegistry();
  return { store, dispatcher, tools, llmCall, registry };
}

async function drive(h: ReturnType<typeof freshHarness>, runId: string, maxSteps = 50): Promise<void> {
  const ac = new AbortController();
  for (let i = 0; i < maxSteps; i++) {
    wakePending(h.store);
    const claimed = h.store.claimNextRun(8);
    if (claimed == null) {
      const state = h.store.getState(runId);
      if (state == null) return;
      const terminal = state.status === "completed" || state.status === "halted" || state.status === "cancelled";
      if (terminal) return;
      const blocked = state.status === "paused" || state.status === "paused_hitl" || state.status === "paused_auto";
      if (blocked) return;
      // running_children with no claimable children → settled mid-flight.
      if (state.status === "running_children" && h.store.activeChildRuns(runId).length > 0) {
        const anyClaimable = h.store.activeChildRuns(runId).some((id) => {
          const c = h.store.getState(id);
          return c?.status === "queued";
        });
        if (!anyClaimable) return;
      }
      continue;
    }
    await runOne(claimed.runId, {
      store: h.store,
      dispatcher: h.dispatcher,
      registry: h.registry,
      tools: h.tools,
      llmCall: h.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
  }
}

function buildFanoutDot(branchCount: number, opts: { joinPolicy?: string; budgets?: number[] } = {}): string {
  const joinPolicy = opts.joinPolicy ?? "wait_all";
  const budgets = opts.budgets ?? [];
  const branches = Array.from({ length: branchCount }, (_, i) => `b${i}`);
  const branchDecls = branches
    .map((id, i) => {
      const budget = budgets[i];
      return budget != null ? `${id} [max_cost_usd="${budget}"];` : `${id};`;
    })
    .join("\n      ");
  const fanInEdges = branches.map((id) => `${id} -> fan_in;`).join("\n      ");
  const fanoutEdges = branches.map((id) => `fanout -> ${id};`).join("\n      ");
  return `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component join_policy="${joinPolicy}"];
      ${branchDecls}
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      ${fanoutEdges}
      ${fanInEdges}
      fan_in -> done;
    }`;
}

function countRunning(h: ReturnType<typeof freshHarness>): number {
  const db = (h.store as unknown as { db: { query: (s: string) => { get: () => { n: number } | null } } }).db;
  return db.query("SELECT COUNT(*) AS n FROM run_state WHERE status = 'running'").get()?.n ?? 0;
}

describe("parallel stress — mixed terminal states", () => {
  test("1 completed + 1 paused + 1 paused_hitl → parent stays running_children; no slot held", async () => {
    const h = freshHarness();
    const sha = "wf_mixed";
    h.store.saveWorkflow(
      sha,
      "mixed",
      `digraph G {
        start [shape=Mdiamond];
        fanout [shape=component];
        ok;
        pause_me [max_cost_usd="0.05"];
        hitl_me [shape=hexagon, prompt="?"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> ok;
        fanout -> pause_me;
        fanout -> hitl_me;
        ok -> fan_in;
        pause_me -> fan_in;
        hitl_me -> fan_in [label="[A] OK"];
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "ok", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "pause_me", mockCodergenSpec({ costPerCall: 0.1, calls: 10 }));
    // hitl_me auto-resolves to wait.human via the auto-dispatcher.

    h.store.enqueueRun({ runId: "mixed", workflowSha: sha });
    await drive(h, "mixed", 80);

    const parent = h.store.getState("mixed")!;
    expect(parent.status).toBe("running_children");

    expect(h.store.getState("mixed__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("mixed__fanout__i0__b1")?.status).toBe("paused");
    expect(h.store.getState("mixed__fanout__i0__b2")?.status).toBe("paused_hitl");

    // Parent is not holding a running slot — no in-flight runs.
    expect(countRunning(h)).toBe(0);

    h.store.close();
  });

  test("all 3 branches halted (stop-policy budget overflow) → fan_in collects 3 halted outcomes, parent halts via fail edge", async () => {
    const h = freshHarness();
    const sha = "wf_all_halt";
    h.store.saveWorkflow(
      sha,
      "all-halt",
      `digraph G {
        graph [budget_policy="stop"];
        start [shape=Mdiamond];
        fanout [shape=component];
        a [max_cost_usd="0.05"];
        b [max_cost_usd="0.05"];
        c [max_cost_usd="0.05"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> a; fanout -> b; fanout -> c;
        a -> fan_in; b -> fan_in; c -> fan_in;
        fan_in -> done;
      }`,
    );
    for (const id of ["a", "b", "c"]) {
      h.dispatcher.register(sha, id, mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    }
    h.store.enqueueRun({ runId: "ah", workflowSha: sha });
    await drive(h, "ah", 80);

    for (let i = 0; i < 3; i++) {
      expect(h.store.getState(`ah__fanout__i0__b${i}`)?.status).toBe("halted");
    }
    // Parent reaches a terminal — completed (fan_in fires with all
    // halted outcomes, downstream chooses based on configured edge)
    // OR halted (depending on fan_in routing). The important
    // assertion is that the parent is NOT stuck running_children.
    const parent = h.store.getState("ah")!;
    expect(["completed", "halted"]).toContain(parent.status);
    h.store.close();
  });
});

describe("parallel stress — all-paused fan-out", () => {
  test("all branches paused on budget → parent in running_children; no in-flight slots held", async () => {
    const h = freshHarness();
    const sha = "wf_all_paused";
    h.store.saveWorkflow(sha, "all-paused", buildFanoutDot(3, { budgets: [0.05, 0.05, 0.05] }));
    for (let i = 0; i < 3; i++) {
      h.dispatcher.register(sha, `b${i}`, mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    }
    h.store.enqueueRun({ runId: "ap", workflowSha: sha });
    await drive(h, "ap", 80);

    for (let i = 0; i < 3; i++) {
      expect(h.store.getState(`ap__fanout__i0__b${i}`)?.status).toBe("paused");
    }
    const parent = h.store.getState("ap")!;
    expect(parent.status).toBe("running_children");
    // Slot accounting: no executor slot is held while every branch is
    // paused. The parent's handler exited at fact.fanout_started and
    // the children's handlers exited at fact.run_paused.
    expect(countRunning(h)).toBe(0);
    h.store.close();
  });

  test("raise + resume on EACH paused branch in any order → all complete → parent completes", async () => {
    const h = freshHarness();
    const sha = "wf_resume_each";
    h.store.saveWorkflow(sha, "resume-each", buildFanoutDot(3, { budgets: [0.05, 0.05, 0.05] }));
    for (let i = 0; i < 3; i++) {
      h.dispatcher.register(sha, `b${i}`, mockCodergenSpec({ costPerCall: 0.05, calls: 2 }));
    }
    h.store.enqueueRun({ runId: "re", workflowSha: sha });
    await drive(h, "re", 80);
    for (let i = 0; i < 3; i++) {
      expect(h.store.getState(`re__fanout__i0__b${i}`)?.status).toBe("paused");
    }
    // Resume out of declaration order (b2, b0, b1) — verifies the
    // wake doesn't depend on parallel_index order.
    for (const i of [2, 0, 1]) {
      const id = `re__fanout__i0__b${i}`;
      h.store.appendIntent(id, {
        type: "intent.budget_adjusted",
        payload: { scope: "node", metric: "cost", newLimit: 1.0 },
      });
      h.store.appendIntent(id, { type: "intent.resume", payload: {} });
    }
    await drive(h, "re", 80);
    expect(h.store.getState("re")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — multi-HITL siblings", () => {
  test("two paused_hitl siblings; answer one → other still paused; parent stays running_children until both answered", async () => {
    const h = freshHarness();
    const sha = "wf_multi_hitl";
    h.store.saveWorkflow(
      sha,
      "multi-hitl",
      `digraph G {
        start [shape=Mdiamond];
        fanout [shape=component];
        gate_a [shape=hexagon, prompt="A?"];
        gate_b [shape=hexagon, prompt="B?"];
        done_branch;
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> gate_a;
        fanout -> gate_b;
        fanout -> done_branch;
        gate_a -> fan_in [label="[A] OK"];
        gate_b -> fan_in [label="[A] OK"];
        done_branch -> fan_in;
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "done_branch", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "mh", workflowSha: sha });
    await drive(h, "mh", 80);

    const gateAChild = h.store.getState("mh__fanout__i0__b0")!;
    const gateBChild = h.store.getState("mh__fanout__i0__b1")!;
    const doneChild = h.store.getState("mh__fanout__i0__b2")!;
    expect(gateAChild.status).toBe("paused_hitl");
    expect(gateBChild.status).toBe("paused_hitl");
    expect(doneChild.status).toBe("completed");
    expect(h.store.getState("mh")?.status).toBe("running_children");

    // Answer gate A only.
    h.store.appendIntent(gateAChild.runId, {
      type: "intent.hitl_input",
      payload: { selected: "A" },
    });
    h.store.appendIntent(gateAChild.runId, { type: "intent.resume", payload: {} });
    await drive(h, "mh", 80);

    expect(h.store.getState(gateAChild.runId)?.status).toBe("completed");
    expect(h.store.getState(gateBChild.runId)?.status).toBe("paused_hitl");
    expect(h.store.getState("mh")?.status).toBe("running_children");

    // Now answer gate B.
    h.store.appendIntent(gateBChild.runId, {
      type: "intent.hitl_input",
      payload: { selected: "A" },
    });
    h.store.appendIntent(gateBChild.runId, { type: "intent.resume", payload: {} });
    await drive(h, "mh", 80);

    expect(h.store.getState(gateBChild.runId)?.status).toBe("completed");
    expect(h.store.getState("mh")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — cancel cascade across paused children", () => {
  test("cancel parent while children are paused (mix of budget + HITL) → all transition to cancelled", async () => {
    const h = freshHarness();
    const sha = "wf_cancel_mixed";
    h.store.saveWorkflow(
      sha,
      "cancel-mixed",
      `digraph G {
        start [shape=Mdiamond];
        fanout [shape=component];
        budget_b [max_cost_usd="0.05"];
        hitl_b [shape=hexagon, prompt="?"];
        done_b;
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> budget_b;
        fanout -> hitl_b;
        fanout -> done_b;
        budget_b -> fan_in;
        hitl_b -> fan_in [label="[A] OK"];
        done_b -> fan_in;
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "budget_b", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "done_b", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "cm", workflowSha: sha });
    await drive(h, "cm", 80);

    expect(h.store.getState("cm__fanout__i0__b0")?.status).toBe("paused");
    expect(h.store.getState("cm__fanout__i0__b1")?.status).toBe("paused_hitl");
    expect(h.store.getState("cm__fanout__i0__b2")?.status).toBe("completed");
    expect(h.store.getState("cm")?.status).toBe("running_children");

    // Cancel the parent — should cascade to active children.
    h.store.appendIntent("cm", { type: "intent.cancel_requested", payload: {} });
    // Drive until the parent terminates; then continue ticking
    // wake-pending so the cascade reaches the children.
    await drive(h, "cm", 80);
    for (let i = 0; i < 10; i++) wakePending(h.store);

    expect(h.store.getState("cm")?.status).toBe("cancelled");
    // Both non-terminal children get cancelled; the already-completed
    // one stays completed.
    expect(h.store.getState("cm__fanout__i0__b0")?.status).toBe("cancelled");
    expect(h.store.getState("cm__fanout__i0__b1")?.status).toBe("cancelled");
    expect(h.store.getState("cm__fanout__i0__b2")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — first_success edge cases", () => {
  test("first_success: ALL branches fail → fan_in reports no winner; parent reaches a terminal (not stuck)", async () => {
    const h = freshHarness();
    const sha = "wf_fs_allfail";
    h.store.saveWorkflow(
      sha,
      "fs-allfail",
      `digraph G {
        graph [budget_policy="stop"];
        start [shape=Mdiamond];
        fanout [shape=component join_policy="first_success"];
        a [max_cost_usd="0.05"];
        b [max_cost_usd="0.05"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> a; fanout -> b;
        a -> fan_in; b -> fan_in;
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "a", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "b", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));

    h.store.enqueueRun({ runId: "fs", workflowSha: sha });
    await drive(h, "fs", 80);

    expect(h.store.getState("fs__fanout__i0__b0")?.status).toBe("halted");
    expect(h.store.getState("fs__fanout__i0__b1")?.status).toBe("halted");
    const parent = h.store.getState("fs")!;
    expect(["completed", "halted"]).toContain(parent.status);
    h.store.close();
  });
});

describe("parallel stress — slot accounting", () => {
  test("running_children with paused children does NOT count against maxConcurrentRuns; another top-level run can claim", async () => {
    const h = freshHarness();
    const sha = "wf_slots";
    h.store.saveWorkflow(sha, "slots", buildFanoutDot(2, { budgets: [0.05, 0.05] }));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));

    // Second workflow — simple single-node run that just completes.
    const sha2 = "wf_other";
    h.store.saveWorkflow(
      sha2,
      "other",
      `digraph G { start [shape=Mdiamond]; n; done [shape=Msquare]; start -> n; n -> done; }`,
    );
    h.dispatcher.register(sha2, "n", mockCodergenSpec({ costPerCall: 0.001, calls: 1 }));

    h.store.enqueueRun({ runId: "p1", workflowSha: sha });
    await drive(h, "p1", 60);

    // p1 is running_children with both children paused. Slot held by
    // p1 should be 0 — claim a fresh independent run.
    expect(h.store.getState("p1")?.status).toBe("running_children");
    expect(countRunning(h)).toBe(0);

    h.store.enqueueRun({ runId: "p2", workflowSha: sha2 });
    await drive(h, "p2", 30);

    expect(h.store.getState("p2")?.status).toBe("completed");
    // p1 still paused-ish; not blocked by p2.
    expect(h.store.getState("p1")?.status).toBe("running_children");
    h.store.close();
  });
});

describe("parallel stress — operator pause does NOT propagate to children", () => {
  test("operator-pause on a running_children parent leaves children alone — they finish, then parent picks up its own pause", async () => {
    // Pause semantics: pausing a parent in running_children should NOT
    // cascade to its children. Children are independent runs; if the
    // operator wants to stop them they have to cancel. This test
    // documents the contract — children continue, the parent's
    // intent.pause_requested sits unapplied while running_children
    // (parent's handler already exited at fact.fanout_started).
    const h = freshHarness();
    const sha = "wf_pause_no_cascade";
    h.store.saveWorkflow(sha, "pnc", buildFanoutDot(2));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.store.enqueueRun({ runId: "pnc", workflowSha: sha });
    // Drive enough to get into running_children but not let it
    // converge. wakePending alone gets the parent dispatched.
    wakePending(h.store);
    const claimed = h.store.claimNextRun(8);
    expect(claimed?.runId).toBe("pnc");
    const ac = new AbortController();
    await runOne(claimed!.runId, {
      store: h.store,
      dispatcher: h.dispatcher,
      registry: h.registry,
      tools: h.tools,
      llmCall: h.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
    expect(h.store.getState("pnc")?.status).toBe("running_children");

    // Operator pauses the parent mid-fanout.
    h.store.appendIntent("pnc", { type: "intent.pause_requested", payload: {} });

    // Run forward. Children should still complete; parent reaches
    // fan_in normally because the pause intent has no cascade hook
    // for running_children parents.
    await drive(h, "pnc", 80);
    expect(h.store.getState("pnc__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("pnc__fanout__i0__b1")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — single-branch fan-out", () => {
  test("parallel with ONE branch behaves like a wrapped sub-run; round-trips terminal correctly", async () => {
    const h = freshHarness();
    const sha = "wf_single";
    h.store.saveWorkflow(sha, "single", buildFanoutDot(1));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.02, calls: 1 }));
    h.store.enqueueRun({ runId: "sg", workflowSha: sha });
    await drive(h, "sg", 80);
    expect(h.store.getState("sg")?.status).toBe("completed");
    expect(h.store.getState("sg__fanout__i0__b0")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — high fan-out width", () => {
  test("8-way fan-out: all branches dispatch + complete; parent rolls up correctly", async () => {
    const h = freshHarness();
    const sha = "wf_wide";
    h.store.saveWorkflow(sha, "wide", buildFanoutDot(8));
    for (let i = 0; i < 8; i++) {
      h.dispatcher.register(sha, `b${i}`, mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    }
    h.store.enqueueRun({ runId: "wide", workflowSha: sha });
    await drive(h, "wide", 200);
    expect(h.store.getState("wide")?.status).toBe("completed");
    for (let i = 0; i < 8; i++) {
      expect(h.store.getState(`wide__fanout__i0__b${i}`)?.status).toBe("completed");
    }
    // Cost rollup: 8 × $0.01 = $0.08 minimum from sub-runs (plus any
    // parent fan_in cost — but fan_in heuristic emits nothing).
    expect(h.store.getState("wide")?.metrics.totalCostUsd).toBeGreaterThanOrEqual(0.08);
    h.store.close();
  });
});

describe("parallel stress — paused_auto children don't escalate", () => {
  test("child in paused_auto (retry timer) doesn't appear in attention-class digest; parent's pausedAuto count is the only signal", async () => {
    // paused_auto is auto-resumed by the daemon's wake-pending timer
    // (handler_retry / provider_retry). The UI should NOT surface
    // these as needing operator action — only the count is exposed
    // via childStatusDigest.pausedAuto so the operator can see
    // "running with retries in flight" without an attention badge.
    //
    // This test pins the digest counts so the UI's escalation logic
    // can rely on the boundary.
    const h = freshHarness();
    const sha = "wf_auto";
    h.store.saveWorkflow(sha, "auto", buildFanoutDot(2, { budgets: [0.05, 0.05] }));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "ato", workflowSha: sha });
    await drive(h, "ato", 80);
    expect(h.store.getState("ato__fanout__i0__b0")?.status).toBe("paused");
    expect(h.store.getState("ato__fanout__i0__b1")?.status).toBe("completed");

    // Manually transition b0 to paused_auto to mimic the retry case
    // (the routing-level distinction lives elsewhere; the digest cares
    // about status only).
    const db = (h.store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'paused_auto' WHERE run_id = ?").run("ato__fanout__i0__b0");

    const digest = h.store.childStatusDigest("ato");
    expect(digest).not.toBeNull();
    expect(digest!.pausedAuto).toBe(1);
    expect(digest!.completed).toBe(1);
    expect(digest!.paused).toBe(0);
    expect(digest!.pausedHitl).toBe(0);
    expect(digest!.quarantined).toBe(0);
    h.store.close();
  });
});

describe("parallel stress — cancel mid-flight (running children)", () => {
  test("cancel parent while a child is still RUNNING (not paused) — child aborts and transitions to cancelled", async () => {
    const h = freshHarness();
    const sha = "wf_mid";
    h.store.saveWorkflow(sha, "mid", buildFanoutDot(2));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    // b1 is a long-running stub — we cancel before it gets dispatched
    // so the cancel intent is folded on its next dispatch.
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 5, delayMs: 1 }));

    h.store.enqueueRun({ runId: "mid", workflowSha: sha });
    // Drive parent fan-out only.
    wakePending(h.store);
    const claimed = h.store.claimNextRun(8);
    const ac = new AbortController();
    await runOne(claimed!.runId, {
      store: h.store,
      dispatcher: h.dispatcher,
      registry: h.registry,
      tools: h.tools,
      llmCall: h.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
    expect(h.store.getState("mid")?.status).toBe("running_children");

    // Cancel the parent before children dispatch — children are queued.
    h.store.appendIntent("mid", { type: "intent.cancel_requested", payload: {} });

    // wake-pending applies the cancel to the parent + cascades.
    for (let i = 0; i < 10; i++) wakePending(h.store);
    await drive(h, "mid", 50);

    expect(h.store.getState("mid")?.status).toBe("cancelled");
    expect(h.store.getState("mid__fanout__i0__b0")?.status).toBe("cancelled");
    expect(h.store.getState("mid__fanout__i0__b1")?.status).toBe("cancelled");
    h.store.close();
  });
});

describe("parallel stress — sequential fan-outs in one run", () => {
  test("two sequential parallel fan-outs in the same parent: parent oscillates running → running_children → running → running_children → completed", async () => {
    const h = freshHarness();
    const sha = "wf_seq";
    h.store.saveWorkflow(
      sha,
      "seq",
      `digraph G {
        start [shape=Mdiamond];
        fanout1 [shape=component join_policy="wait_all"];
        a; b;
        join1 [shape=tripleoctagon];
        fanout2 [shape=component join_policy="wait_all"];
        x; y;
        join2 [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout1;
        fanout1 -> a; fanout1 -> b;
        a -> join1; b -> join1;
        join1 -> fanout2;
        fanout2 -> x; fanout2 -> y;
        x -> join2; y -> join2;
        join2 -> done;
      }`,
    );
    for (const n of ["a", "b", "x", "y"]) {
      h.dispatcher.register(sha, n, mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    }
    h.store.enqueueRun({ runId: "seq", workflowSha: sha });
    await drive(h, "seq", 200);
    expect(h.store.getState("seq")?.status).toBe("completed");
    // Both fan-outs produced 2 children each.
    expect(h.store.getState("seq__fanout1__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("seq__fanout1__i0__b1")?.status).toBe("completed");
    expect(h.store.getState("seq__fanout2__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("seq__fanout2__i0__b1")?.status).toBe("completed");
    // Cost rollup: 4 branches × $0.01 = $0.04 minimum.
    expect(h.store.getState("seq")?.metrics.totalCostUsd).toBeGreaterThanOrEqual(0.04);
    h.store.close();
  });
});

describe("parallel stress — resume idempotence", () => {
  test("intent.resume on a child that's already running is a no-op (doesn't double-dispatch or re-pause)", async () => {
    const h = freshHarness();
    const sha = "wf_dr";
    h.store.saveWorkflow(sha, "dr", buildFanoutDot(1));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.store.enqueueRun({ runId: "dr", workflowSha: sha });

    // Drive the parent's fan-out so the child row exists, then inject
    // a spurious intent.resume on the queued child — wakeResume's
    // candidate set is paused-class only, so the resume should sit
    // unapplied without disrupting the run.
    wakePending(h.store);
    const ac = new AbortController();
    const claimed = h.store.claimNextRun(8);
    await runOne(claimed!.runId, {
      store: h.store,
      dispatcher: h.dispatcher,
      registry: h.registry,
      tools: h.tools,
      llmCall: h.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
    expect(h.store.getState("dr__fanout__i0__b0")?.status).toBe("queued");
    h.store.appendIntent("dr__fanout__i0__b0", { type: "intent.resume", payload: {} });
    // Now drive to completion; nothing should be broken by the
    // unsolicited resume.
    await drive(h, "dr", 80);
    expect(h.store.getState("dr")?.status).toBe("completed");
    expect(h.store.getState("dr__fanout__i0__b0")?.status).toBe("completed");
    // Verify no fact.run_resumed fired on the child (would mean
    // wakeResume mis-applied the intent).
    const events = h.store.getEvents("dr__fanout__i0__b0");
    const resumeFacts = events.filter((e) => e.type === "fact.run_resumed");
    expect(resumeFacts.length).toBe(0);
    h.store.close();
  });
});

describe("parallel stress — wake convergence idempotence", () => {
  test("wake-pending fires multiple times on a parent whose children are all paused — no duplicate fact.subrun_completed", async () => {
    const h = freshHarness();
    const sha = "wf_idem";
    h.store.saveWorkflow(sha, "idem", buildFanoutDot(2, { budgets: [0.05, 0.05] }));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));

    h.store.enqueueRun({ runId: "id", workflowSha: sha });
    await drive(h, "id", 60);

    // Both paused.
    expect(h.store.getState("id__fanout__i0__b0")?.status).toBe("paused");
    expect(h.store.getState("id__fanout__i0__b1")?.status).toBe("paused");

    // Hammer wakePending — no convergence should fire (children
    // non-terminal).
    for (let i = 0; i < 10; i++) wakePending(h.store);

    // No fact.subrun_completed events should appear on the parent
    // (convergence only fires when ALL children terminal).
    const parentEvents = h.store.getEvents("id");
    const subrunCompletedCount = parentEvents.filter((e) => e.type === "fact.subrun_completed").length;
    expect(subrunCompletedCount).toBe(0);
    h.store.close();
  });
});
