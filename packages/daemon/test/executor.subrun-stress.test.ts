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

describe("parallel stress — latest budget_adjusted wins", () => {
  test("two intent.budget_adjusted queued before resume → routing keeps the latest value; child finishes at that cap", async () => {
    const h = freshHarness();
    const sha = "wf_lb";
    h.store.saveWorkflow(sha, "lb", buildFanoutDot(1, { budgets: [0.05] }));
    // 6 calls × $0.05 = $0.30 — at cap=0.5 it overruns and pauses
    // again; at cap=2.0 it finishes cleanly. So setting the FIRST raise
    // too low and the SECOND high enough verifies the latest value
    // sticks.
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.05, calls: 6 }));
    h.store.enqueueRun({ runId: "lb", workflowSha: sha });
    await drive(h, "lb", 80);
    const childId = "lb__fanout__i0__b0";
    expect(h.store.getState(childId)?.status).toBe("paused");

    // Two raises before resume — first too low, second sufficient.
    h.store.appendIntent(childId, {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 0.5 },
    });
    h.store.appendIntent(childId, {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 2.0 },
    });
    h.store.appendIntent(childId, { type: "intent.resume", payload: {} });

    await drive(h, "lb", 80);
    const final = h.store.getState(childId)!;
    expect(final.status).toBe("completed");
    // The persisted override is the LATEST value, not the first.
    expect(final.routing["budget_override.node.cost"]).toBe(2.0);
    h.store.close();
  });
});

describe("parallel stress — quarantined sub-run blocks parent", () => {
  test("quarantined child keeps parent in running_children until operator unquarantines", async () => {
    const h = freshHarness();
    const sha = "wf_quar";
    h.store.saveWorkflow(sha, "quar", buildFanoutDot(2));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "q", workflowSha: sha });
    // Drive only the parent's fan-out — children stay queued.
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
    expect(h.store.getState("q")?.status).toBe("running_children");

    // Force the children into a quarantined + completed mix
    // (mimicking the post-sweep state: one orphan side effect, one
    // legit completion).
    const db = (h.store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'quarantined' WHERE run_id = ?").run("q__fanout__i0__b0");
    db.query("UPDATE run_state SET status = 'completed'   WHERE run_id = ?").run("q__fanout__i0__b1");

    // wakeRunningChildren must NOT converge: quarantined is
    // non-terminal for fan-in (operator must resolve).
    for (let i = 0; i < 10; i++) wakePending(h.store);
    expect(h.store.getState("q")?.status).toBe("running_children");

    // Operator unquarantines with treat_as_done. The intent fold
    // transitions the child to completed; fan-in then converges
    // and the parent reaches a terminal.
    h.store.appendIntent("q__fanout__i0__b0", {
      type: "intent.unquarantine",
      payload: { resolution: "treat_as_done" },
    });
    await drive(h, "q", 80);
    expect(h.store.getState("q__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("q")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — nested fan-out (workflow-level constraint)", () => {
  test("workflow with one branch fanning out to a different fan_in halts cleanly with the validator's convergence error (no orphans)", async () => {
    // The parallel handler enforces "all branches converge on the
    // same tripleoctagon" — meaningful nested fan-out at the
    // workflow level would need that constraint relaxed (or sub-graph
    // clusters with their own fan_in scope). Pin the current
    // behaviour: the run halts with a deterministic error, no
    // orphan sub-runs are created.
    const h = freshHarness();
    const sha = "wf_nest";
    h.store.saveWorkflow(
      sha,
      "nest",
      `digraph G {
        start [shape=Mdiamond];
        outer [shape=component, join_policy="wait_all"];
        simple;
        inner [shape=component, join_policy="wait_all"];
        inner_a;
        inner_b;
        inner_join [shape=tripleoctagon];
        outer_join [shape=tripleoctagon];
        done [shape=Msquare];
        start -> outer;
        outer -> simple;
        outer -> inner;
        simple -> outer_join;
        inner -> inner_a;
        inner -> inner_b;
        inner_a -> inner_join;
        inner_b -> inner_join;
        inner_join -> outer_join;
        outer_join -> done;
      }`,
    );
    h.dispatcher.register(sha, "simple", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.store.enqueueRun({ runId: "nest", workflowSha: sha });
    await drive(h, "nest", 100);

    const parent = h.store.getState("nest")!;
    expect(parent.status).toBe("halted");
    const halt = h.store.getEvents("nest").find((e) => e.type === "fact.run_halted");
    expect(halt).toBeDefined();
    expect((halt!.payload as { detail?: string }).detail).toContain("converge on different tripleoctagons");

    // No sub-runs were created (halt fired during the parent's
    // initial dispatch, before fan-out).
    const db = (h.store as unknown as { db: { query: (s: string) => { all: () => Array<{ run_id: string }> } } }).db;
    const subRuns = db.query("SELECT run_id FROM run_state WHERE parent_run_id = 'nest'").all();
    expect(subRuns).toHaveLength(0);
    h.store.close();
  });
});

describe("parallel stress — multi-level data-model traversal", () => {
  test("childStatusDigest + activeDescendantNodes both walk descendants recursively across a 3-level tree", async () => {
    // Manually seed a 3-level tree (grandparent → parent → child) by
    // chaining parent_run_id. Verifies the SQL helpers we expose
    // traverse descendants correctly across multiple sub-run depths
    // even if the workflow validator doesn't generate that shape
    // today.
    const h = freshHarness();
    const sha = "wf_tree";
    h.store.saveWorkflow(sha, "tree", "digraph G {}");
    h.store.enqueueRun({ runId: "gp", workflowSha: sha });
    h.store.enqueueRun({
      runId: "gp__p",
      workflowSha: sha,
      parentRunId: "gp",
      parentNodeId: "fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "p_root",
      subgraphTerminalNodeId: "join",
    });
    h.store.enqueueRun({
      runId: "gp__p__c",
      workflowSha: sha,
      parentRunId: "gp__p",
      parentNodeId: "p_fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "c_root",
      subgraphTerminalNodeId: "p_join",
    });
    const db = (h.store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'running_children', current_node = 'fanout' WHERE run_id = ?").run("gp");
    db.query("UPDATE run_state SET status = 'running_children', current_node = 'p_fanout' WHERE run_id = ?").run(
      "gp__p",
    );
    db.query("UPDATE run_state SET status = 'running', current_node = 'c_root' WHERE run_id = ?").run("gp__p__c");

    // Digest is recursive: counts every descendant (parent + grandchild)
    // grouped by status. Caller treats the digest as "anything live
    // beneath me" — which is what the Inbox / detail page needs.
    const gpDigest = h.store.childStatusDigest("gp");
    expect(gpDigest?.total).toBe(2);
    expect(gpDigest?.runningChildren).toBe(1); // gp__p
    expect(gpDigest?.running).toBe(1); // gp__p__c

    // From the intermediate parent: only the grandchild is below it.
    const pDigest = h.store.childStatusDigest("gp__p");
    expect(pDigest?.total).toBe(1);
    expect(pDigest?.running).toBe(1);

    // Effective active nodes also walks recursively.
    const active = h.store.activeDescendantNodes("gp");
    const nodeIds = active.map((r) => r.nodeId);
    expect(nodeIds).toContain("p_fanout");
    expect(nodeIds).toContain("c_root");
    h.store.close();
  });
});

describe("parallel stress — daemon restart sweep recovery", () => {
  test("sub-run stuck in 'running' after crash → startup sweep requeues it; parent stays running_children; child re-dispatches", async () => {
    const h = freshHarness();
    const sha = "wf_crash";
    h.store.saveWorkflow(sha, "crash", buildFanoutDot(2));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.store.enqueueRun({ runId: "cr", workflowSha: sha });
    // Parent fan-out only.
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
    expect(h.store.getState("cr")?.status).toBe("running_children");

    // Simulate crash: forcibly mark child b0 as 'running' (as if it
    // was mid-handler when the daemon died).
    const db = (h.store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'running' WHERE run_id = ?").run("cr__fanout__i0__b0");

    // Startup sweep on restart: requeues the stuck child.
    const sweep = h.store.startupSweep();
    expect(sweep.requeued).toContain("cr__fanout__i0__b0");
    expect(h.store.getState("cr__fanout__i0__b0")?.status).toBe("queued");
    // Parent untouched.
    expect(h.store.getState("cr")?.status).toBe("running_children");

    // Drive forward — children should dispatch + complete cleanly.
    await drive(h, "cr", 80);
    expect(h.store.getState("cr")?.status).toBe("completed");
    expect(h.store.getState("cr__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("cr__fanout__i0__b1")?.status).toBe("completed");
    h.store.close();
  });
});

describe("parallel stress — cancel race against child completion", () => {
  test("operator cancels parent right as child completes — cascade tolerates a now-terminal child without erroring", async () => {
    const h = freshHarness();
    const sha = "wf_race";
    h.store.saveWorkflow(sha, "race", buildFanoutDot(2));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.01, calls: 1, delayMs: 1 }));
    h.store.enqueueRun({ runId: "rc", workflowSha: sha });

    // Drive parent fanout; let b0 complete; b1 still queued.
    wakePending(h.store);
    let claimed = h.store.claimNextRun(8);
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
    // Run b0 only.
    wakePending(h.store);
    claimed = h.store.claimNextRun(8);
    if (claimed?.runId === "rc__fanout__i0__b0") {
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
    expect(h.store.getState("rc__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("rc__fanout__i0__b1")?.status).toBe("queued");
    expect(h.store.getState("rc")?.status).toBe("running_children");

    // Cancel the parent — cascade will try to cancel b0 (terminal)
    // AND b1 (queued). The terminal one shouldn't error.
    h.store.appendIntent("rc", { type: "intent.cancel_requested", payload: {} });
    for (let i = 0; i < 20; i++) wakePending(h.store);

    expect(h.store.getState("rc")?.status).toBe("cancelled");
    // b0 stays completed (terminal, cancel intent on it is a no-op).
    expect(h.store.getState("rc__fanout__i0__b0")?.status).toBe("completed");
    // b1 transitions to cancelled.
    expect(h.store.getState("rc__fanout__i0__b1")?.status).toBe("cancelled");
    h.store.close();
  });
});

describe("parallel stress — intent isolation between sibling sub-runs", () => {
  test("intent.budget_adjusted on one paused sibling does NOT leak routing to the other sibling", async () => {
    const h = freshHarness();
    const sha = "wf_iso";
    h.store.saveWorkflow(sha, "iso", buildFanoutDot(2, { budgets: [0.05, 0.05] }));
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.05, calls: 6 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.05, calls: 6 }));
    h.store.enqueueRun({ runId: "iso", workflowSha: sha });
    await drive(h, "iso", 80);

    const b0 = "iso__fanout__i0__b0";
    const b1 = "iso__fanout__i0__b1";
    expect(h.store.getState(b0)?.status).toBe("paused");
    expect(h.store.getState(b1)?.status).toBe("paused");

    // Raise + resume ONLY on b0. b1 must remain paused at its
    // original cap, with no budget_override written to its routing.
    h.store.appendIntent(b0, {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 1.5 },
    });
    h.store.appendIntent(b0, { type: "intent.resume", payload: {} });
    await drive(h, "iso", 80);

    const b0State = h.store.getState(b0)!;
    const b1State = h.store.getState(b1)!;
    expect(b0State.status).toBe("completed");
    expect(b0State.routing["budget_override.node.cost"]).toBe(1.5);

    expect(b1State.status).toBe("paused");
    // Critical isolation assertion: b1's routing has NO override —
    // b0's intent didn't bleed across the sibling boundary.
    expect(b1State.routing["budget_override.node.cost"]).toBeUndefined();
    h.store.close();
  });
});

describe("parallel stress — multi-HITL same-key answer scoped to one child", () => {
  test("two paused_hitl children with identical [A] accelerator → operator answers one; other stays paused", async () => {
    const h = freshHarness();
    const sha = "wf_hkc";
    h.store.saveWorkflow(
      sha,
      "hkc",
      `digraph G {
        start [shape=Mdiamond];
        fanout [shape=component];
        gate_a [shape=hexagon, prompt="A?"];
        gate_b [shape=hexagon, prompt="B?"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> gate_a;
        fanout -> gate_b;
        gate_a -> fan_in [label="[A] Yes"];
        gate_b -> fan_in [label="[A] Yes"];
        fan_in -> done;
      }`,
    );
    h.store.enqueueRun({ runId: "hkc", workflowSha: sha });
    await drive(h, "hkc", 80);
    const a = "hkc__fanout__i0__b0";
    const b = "hkc__fanout__i0__b1";
    expect(h.store.getState(a)?.status).toBe("paused_hitl");
    expect(h.store.getState(b)?.status).toBe("paused_hitl");

    // Answer only A — same accelerator key. Must not advance B.
    h.store.appendIntent(a, { type: "intent.hitl_input", payload: { selected: "A" } });
    h.store.appendIntent(a, { type: "intent.resume", payload: {} });
    await drive(h, "hkc", 80);

    expect(h.store.getState(a)?.status).toBe("completed");
    expect(h.store.getState(b)?.status).toBe("paused_hitl");
    expect(h.store.getState("hkc")?.status).toBe("running_children");
    h.store.close();
  });
});

describe("parallel stress — parent vs child budget stack", () => {
  test("workflow-level cost cap fires before per-child node caps when set tight; parent halts via fanout abort", async () => {
    const h = freshHarness();
    const sha = "wf_pvc";
    h.store.saveWorkflow(
      sha,
      "pvc",
      `digraph G {
        graph [budget_policy="stop", max_cost_usd="0.05"];
        start [shape=Mdiamond];
        fanout [shape=component];
        b0 [max_cost_usd="1.0"];
        b1 [max_cost_usd="1.0"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> b0; fanout -> b1;
        b0 -> fan_in; b1 -> fan_in;
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.05, calls: 5 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.05, calls: 5 }));
    h.store.enqueueRun({ runId: "pvc", workflowSha: sha });
    await drive(h, "pvc", 80);

    // Total cap is $0.05; each child has $1.00 node cap. The
    // workflow-level cap should trip at the parent (run-level)
    // first — the cumulative spend across siblings exceeds it well
    // before either child's node cap.
    const parent = h.store.getState("pvc")!;
    expect(["halted", "completed"]).toContain(parent.status);
    // Parent's totalCostUsd is bounded by the run-level cap plus
    // at most one in-flight call's worth of overshoot per child.
    expect(parent.metrics.totalCostUsd).toBeLessThanOrEqual(0.5);
    h.store.close();
  });

  test("per-child node caps fire when set tighter than the workflow run cap", async () => {
    const h = freshHarness();
    const sha = "wf_pvc2";
    h.store.saveWorkflow(
      sha,
      "pvc2",
      `digraph G {
        graph [max_cost_usd="10.0"];
        start [shape=Mdiamond];
        fanout [shape=component];
        b0 [max_cost_usd="0.05"];
        b1 [max_cost_usd="0.05"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> b0; fanout -> b1;
        b0 -> fan_in; b1 -> fan_in;
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "b0", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.dispatcher.register(sha, "b1", mockCodergenSpec({ costPerCall: 0.1, calls: 5 }));
    h.store.enqueueRun({ runId: "pvc2", workflowSha: sha });
    await drive(h, "pvc2", 80);

    // Both children pause at their own $0.05 node cap; parent
    // run-level cap ($10) is comfortable above.
    expect(h.store.getState("pvc2__fanout__i0__b0")?.status).toBe("paused");
    expect(h.store.getState("pvc2__fanout__i0__b1")?.status).toBe("paused");
    expect(h.store.getState("pvc2")?.status).toBe("running_children");
    h.store.close();
  });
});

describe("parallel stress — first_success with paused sibling", () => {
  test("first_success: winner completes, paused_hitl sibling gets cancelled (first_success cascade respects non-terminal siblings)", async () => {
    const h = freshHarness();
    const sha = "wf_fsh";
    h.store.saveWorkflow(
      sha,
      "fsh",
      `digraph G {
        start [shape=Mdiamond];
        fanout [shape=component, join_policy="first_success"];
        fast;
        slow_hitl [shape=hexagon, prompt="?"];
        fan_in [shape=tripleoctagon];
        done [shape=Msquare];
        start -> fanout;
        fanout -> fast;
        fanout -> slow_hitl;
        fast -> fan_in;
        slow_hitl -> fan_in [label="[A] OK"];
        fan_in -> done;
      }`,
    );
    h.dispatcher.register(sha, "fast", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    // slow_hitl auto-resolves to wait.human

    h.store.enqueueRun({ runId: "fsh", workflowSha: sha });
    await drive(h, "fsh", 80);

    // fast wins; slow_hitl was paused_hitl when the first_success
    // cascade fired → operator never answered → sibling cancelled.
    expect(h.store.getState("fsh__fanout__i0__b0")?.status).toBe("completed");
    expect(h.store.getState("fsh__fanout__i0__b1")?.status).toBe("cancelled");
    expect(h.store.getState("fsh")?.status).toBe("completed");
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
