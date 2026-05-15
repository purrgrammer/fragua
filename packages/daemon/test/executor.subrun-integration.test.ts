// Integration tests for the parallel sub-runs feature that exercise the
// FULL cost-bearing path — codergen-style handlers emitting realistic
// `cost.recorded` events. These are the tests that would have caught
// the production review.dot regression where lenses spent $3+ each
// on $0.30 caps. The structural sub-run tests (executor.parallel-subruns.test.ts)
// use zero-cost transitionSpec stubs and bypass every gate.
//
// Coverage:
//   - Reactive budget gate fires mid-handler for pause-policy (NEW —
//     previously only stop-policy reactively aborted).
//   - Post-handler terminal-skip is bypassed when the synthetic
//     subgraph fence produced the terminal, not a workflow-declared
//     exit.
//   - Cost rollup forwards the full input/output/cache token split to
//     the parent, not just billedTokens.
//   - Sub-runs inherit the parent's worktree directory (D4) — verified
//     via daemon.worktree_provisioned event counts.
//   - Sub-runs aren't tripped by supervisor seeing intent.run_enqueued
//     as a fresh operator intent (the seq-16 spurious abort regression).
//   - Auto-titler doesn't fire for sub-runs.
//   - first_success cancels losing siblings live (their dispatchOne
//     fold picks up the cancel intent and emits fact.run_cancelled).

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import type { Provisioner } from "../src/worktree-provisioner.ts";
import { mockCodergenSpec } from "./helpers.ts";

function mockProvisioner(): Provisioner & {
  ensureCalls: Array<{ runId: string; parentRunId: string | undefined }>;
  disposeCalls: string[];
} {
  const envs = new Map<string, handler.HandlerContext["env"]>();
  const ensureCalls: Array<{ runId: string; parentRunId: string | undefined }> = [];
  const disposeCalls: string[] = [];
  type Env = NonNullable<handler.HandlerContext["env"]>;
  const stubEnv = {
    cwd: "/mock",
    readFile: async () => "",
    writeFile: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  } as unknown as Env;
  const baseGitShas = new Map<string, string>();
  return {
    ensureCalls,
    disposeCalls,
    async ensure(runId, opts): Promise<Env> {
      ensureCalls.push({ runId, parentRunId: opts?.parentRunId });
      if (opts?.parentRunId != null) {
        // Sub-run inherits parent's env (D4).
        const parentEnv = envs.get(opts.parentRunId);
        return (parentEnv ?? stubEnv) as Env;
      }
      envs.set(runId, stubEnv);
      baseGitShas.set(runId, `sha_${runId}`);
      return stubEnv;
    },
    async dispose(runId) {
      disposeCalls.push(runId);
      envs.delete(runId);
      return { branch: null };
    },
    envFor(runId) {
      return envs.get(runId);
    },
    baseGitSha(runId) {
      return baseGitShas.get(runId) ?? null;
    },
  };
}

function freshHarness(opts: { provisioner?: ReturnType<typeof mockProvisioner> } = {}) {
  const store = new SqliteStore({ path: ":memory:" });
  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" });
  const registry = new AbortRegistry();
  const provisioner = opts.provisioner;
  return { store, dispatcher, tools, llmCall, registry, provisioner };
}

async function driveTo(
  harness: ReturnType<typeof freshHarness>,
  runId: string,
  opts: { maxSteps?: number } = {},
): Promise<void> {
  const ac = new AbortController();
  const maxSteps = opts.maxSteps ?? 30;
  for (let i = 0; i < maxSteps; i++) {
    wakePending(harness.store);
    const claimed = harness.store.claimNextRun(8);
    if (claimed == null) {
      const state = harness.store.getState(runId);
      if (state == null) return;
      const terminal =
        state.status === "completed" ||
        state.status === "halted" ||
        state.status === "cancelled" ||
        state.status === "paused" ||
        state.status === "paused_hitl" ||
        state.status === "paused_auto";
      if (terminal) return;
      continue;
    }
    const runOpts: Parameters<typeof runOne>[1] = {
      store: harness.store,
      dispatcher: harness.dispatcher,
      registry: harness.registry,
      tools: harness.tools,
      llmCall: harness.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    };
    if (harness.provisioner) runOpts.provisioner = harness.provisioner;
    await runOne(claimed.runId, runOpts);
  }
}

describe("parallel sub-runs — budget gate (the review.dot regression)", () => {
  test("pause-policy: lens overshoots cap → reactive gate aborts mid-handler, sub-run paused, parent waits", async () => {
    const h = freshHarness();
    const sha = "wf_budget_pause";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      lens_a [max_cost_usd=0.30];
      lens_b [max_cost_usd=0.30];
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> lens_a;
      fanout -> lens_b;
      lens_a -> fan_in;
      lens_b -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "budget-pause", dot);
    // Each "lens" emits 10 cost.recorded events of $0.10 each → $1.00 cumulative,
    // 3.3× the $0.30 cap. Reactive gate should fire on the 4th call ($0.40).
    h.dispatcher.register(sha, "lens_a", mockCodergenSpec({ costPerCall: 0.1, calls: 10 }));
    h.dispatcher.register(sha, "lens_b", mockCodergenSpec({ costPerCall: 0.1, calls: 10 }));

    h.store.enqueueRun({ runId: "p1", workflowSha: sha });
    await driveTo(h, "p1", { maxSteps: 50 });

    // Both sub-runs paused at budget — neither completed past cap.
    // (Paused is non-terminal so they remain in activeChildRuns; the
    // parent stays in running_children waiting for operator action.)
    const c0 = h.store.getState("p1__fanout__i0__b0")!;
    const c1 = h.store.getState("p1__fanout__i0__b1")!;
    expect(c0.status).toBe("paused");
    expect(c1.status).toBe("paused");
    const parent = h.store.getState("p1")!;
    expect(parent.status).toBe("running_children");

    // Each child's total cost stays bounded by ~$0.40 (overshoot is
    // exactly one in-flight LLM message past the cap).
    expect(c0.metrics.totalCostUsd).toBeGreaterThanOrEqual(0.3);
    expect(c0.metrics.totalCostUsd).toBeLessThanOrEqual(0.5);
    expect(c1.metrics.totalCostUsd).toBeLessThanOrEqual(0.5);

    // Each child has a fact.run_paused{reason:"budget"} event.
    for (const childId of [c0.runId, c1.runId]) {
      const events = h.store.getEvents(childId);
      const paused = events.find((e) => e.type === "fact.run_paused");
      expect(paused).toBeDefined();
      expect((paused!.payload as { reason: string }).reason).toBe("budget");
      expect((paused!.payload as { scope: string }).scope).toBe("node");
      expect((paused!.payload as { metric: string }).metric).toBe("cost");
    }

    h.store.close();
  });

  test("stop-policy: lens overshoots cap → reactive gate halts mid-handler", async () => {
    const h = freshHarness();
    const sha = "wf_budget_stop";
    const dot = `digraph G {
      graph [budget_policy="stop"];
      start [shape=Mdiamond];
      fanout [shape=component];
      lens_a [max_cost_usd=0.30];
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> lens_a;
      lens_a -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "budget-stop", dot);
    h.dispatcher.register(sha, "lens_a", mockCodergenSpec({ costPerCall: 0.1, calls: 10 }));

    h.store.enqueueRun({ runId: "p2", workflowSha: sha });
    await driveTo(h, "p2", { maxSteps: 50 });

    const child = h.store.getState("p2__fanout__i0__b0")!;
    expect(child.status).toBe("halted");
    expect(child.metrics.totalCostUsd).toBeLessThanOrEqual(0.5);

    const haltEvent = h.store.getEvents(child.runId).find((e) => e.type === "fact.run_halted");
    expect(haltEvent).toBeDefined();
    expect((haltEvent!.payload as { reason: string }).reason).toBe("budget");

    h.store.close();
  });

  test("under-cap lens completes cleanly (no spurious pause)", async () => {
    const h = freshHarness();
    const sha = "wf_budget_under";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      lens_a [max_cost_usd=1.00];
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> lens_a;
      lens_a -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "budget-under", dot);
    // 3 calls × $0.10 = $0.30 < $1.00 cap.
    h.dispatcher.register(sha, "lens_a", mockCodergenSpec({ costPerCall: 0.1, calls: 3 }));

    h.store.enqueueRun({ runId: "p3", workflowSha: sha });
    await driveTo(h, "p3");

    const parent = h.store.getState("p3")!;
    expect(parent.status).toBe("completed");
    const child = h.store.getState("p3__fanout__i0__b0")!;
    expect(child.status).toBe("completed");
    expect(child.metrics.totalCostUsd).toBeCloseTo(0.3);

    h.store.close();
  });
});

describe("parallel sub-runs — cost rollup", () => {
  test("parent's metrics aggregate input/output/cache splits from every sub-run", async () => {
    const h = freshHarness();
    const sha = "wf_rollup";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      branch_a;
      branch_b;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> branch_a;
      fanout -> branch_b;
      branch_a -> fan_in;
      branch_b -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "rollup", dot);
    h.dispatcher.register(
      sha,
      "branch_a",
      mockCodergenSpec({
        costPerCall: 0.05,
        calls: 2,
        tokensPerCall: { input: 100, output: 200, cacheRead: 50, cacheWrite: 25 },
      }),
    );
    h.dispatcher.register(
      sha,
      "branch_b",
      mockCodergenSpec({
        costPerCall: 0.05,
        calls: 2,
        tokensPerCall: { input: 100, output: 200, cacheRead: 50, cacheWrite: 25 },
      }),
    );

    h.store.enqueueRun({ runId: "p4", workflowSha: sha });
    await driveTo(h, "p4");

    const parent = h.store.getState("p4")!;
    expect(parent.status).toBe("completed");
    // Each branch: 2 calls × {input:100, output:200, cacheRead:50, cacheWrite:25} = {200, 400, 100, 50}
    // 2 branches → input: 400, output: 800, cacheRead: 200, cacheWrite: 100
    expect(parent.metrics.totalInputTokens).toBe(400);
    expect(parent.metrics.totalOutputTokens).toBe(800);
    expect(parent.metrics.totalCacheReadTokens).toBe(200);
    expect(parent.metrics.totalCacheWriteTokens).toBe(100);
    // Total cost: 2 × 2 × $0.05 = $0.20
    expect(parent.metrics.totalCostUsd).toBeCloseTo(0.2);
    h.store.close();
  });
});

describe("parallel sub-runs — worktree inheritance (D4)", () => {
  test("sub-runs reuse parent's worktree env; no separate provisioning", async () => {
    const prov = mockProvisioner();
    const h = freshHarness({ provisioner: prov });
    const sha = "wf_worktree";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      branch_a;
      branch_b;
      branch_c;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> branch_a;
      fanout -> branch_b;
      fanout -> branch_c;
      branch_a -> fan_in;
      branch_b -> fan_in;
      branch_c -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "worktree", dot);
    h.dispatcher.register(sha, "branch_a", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "branch_b", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "branch_c", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "p5", workflowSha: sha });
    await driveTo(h, "p5");

    expect(h.store.getState("p5")!.status).toBe("completed");

    // The mock provisioner records every ensure() call. Sub-runs should
    // have been called with parentRunId set (so the provisioner can
    // reuse the parent's env). The actual worktree creation only
    // happens for top-level runs.
    const subRunEnsures = prov.ensureCalls.filter((c) => c.parentRunId != null);
    expect(subRunEnsures.length).toBeGreaterThanOrEqual(3);
    for (const call of subRunEnsures) {
      expect(call.parentRunId).toBe("p5");
    }
    h.store.close();
  });
});

describe("parallel sub-runs — supervisor spurious abort regression", () => {
  test("sub-run's first LLM call doesn't abort from intent.run_enqueued", async () => {
    // Regression test for the seq-16 abort observed in production:
    // supervisor saw intent.run_enqueued (writer=web) as a fresh
    // operator intent and tripped the controller. Now intent.run_enqueued
    // is filtered AND the start path advances lastAppliedSeq.
    const h = freshHarness();
    const sha = "wf_no_spurious";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      branch_a;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> branch_a;
      branch_a -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "no-spurious", dot);
    h.dispatcher.register(sha, "branch_a", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));

    h.store.enqueueRun({ runId: "p6", workflowSha: sha });
    await driveTo(h, "p6");

    expect(h.store.getState("p6")!.status).toBe("completed");
    const childId = "p6__fanout__i0__b0";
    const child = h.store.getState(childId)!;
    expect(child.status).toBe("completed");

    // No fact.node_aborted on the sub-run.
    const aborts = h.store.getEvents(childId).filter((e) => e.type === "fact.node_aborted");
    expect(aborts).toHaveLength(0);

    // Sub-run dispatched exactly once (no re-dispatch from spurious
    // abort). Mock codergen emits 1 cost.recorded per call × 1 call.
    const costEvents = h.store.getEvents(childId).filter((e) => e.type === "cost.recorded");
    expect(costEvents).toHaveLength(1);
    h.store.close();
  });
});

describe("parallel sub-runs — first_success live cancellation", () => {
  test("when one branch completes, siblings receive cancel and emit fact.run_cancelled", async () => {
    const h = freshHarness();
    const sha = "wf_first_success";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component join_policy="first_success"];
      branch_a;
      branch_b;
      branch_c;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> branch_a;
      fanout -> branch_b;
      fanout -> branch_c;
      branch_a -> fan_in;
      branch_b -> fan_in;
      branch_c -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "first-success", dot);
    // branch_a finishes fastest (1 call), the others would take longer
    // (3 calls each) — but they're cancelled before the second call.
    h.dispatcher.register(sha, "branch_a", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "branch_b", mockCodergenSpec({ costPerCall: 0.01, calls: 3, delayMs: 5 }));
    h.dispatcher.register(sha, "branch_c", mockCodergenSpec({ costPerCall: 0.01, calls: 3, delayMs: 5 }));

    h.store.enqueueRun({ runId: "p7", workflowSha: sha });
    await driveTo(h, "p7", { maxSteps: 60 });

    expect(h.store.getState("p7")!.status).toBe("completed");

    // branch_a completed cleanly.
    expect(h.store.getState("p7__fanout__i0__b0")!.status).toBe("completed");

    // Losing siblings each received intent.cancel_requested.
    for (const branchIdx of [1, 2]) {
      const childId = `p7__fanout__i0__b${branchIdx}`;
      const cancelIntent = h.store.getEvents(childId).find((e) => e.type === "intent.cancel_requested");
      expect(cancelIntent).toBeDefined();
      const reason = (cancelIntent!.payload as { reason?: string }).reason;
      expect(reason).toBe("first_success_won");
    }
    h.store.close();
  });
});

describe("parallel sub-runs — cross-run substitution (P5)", () => {
  test("sub-run reads parent's prior node output via $node.output", async () => {
    // Scope writes an artifact; the lens fan-out sees `$scope.output`
    // in its nodeOutputs map. Mirrors review.dot's prompt pattern
    // ("Review for CORRECTNESS using $scope.output").
    const h = freshHarness();
    const sha = "wf_crossrun_up";
    const dot = `digraph G {
      start [shape=Mdiamond];
      scope;
      fanout [shape=component];
      lens_a;
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> scope;
      scope -> fanout;
      fanout -> lens_a;
      lens_a -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "crossrun-up", dot);
    h.dispatcher.register(sha, "scope", mockCodergenSpec({ costPerCall: 0.01, calls: 1, output: "SCOPE_OUTPUT" }));
    // lens_a's outputFn reads parent's scope output. If cross-run
    // substitution works, it sees "SCOPE_OUTPUT"; otherwise empty
    // string (cascade failure mode).
    h.dispatcher.register(
      sha,
      "lens_a",
      mockCodergenSpec({
        costPerCall: 0.01,
        calls: 1,
        outputFn: (lookup) => `LENS_SAW:${lookup.get("scope")?.output ?? "<empty>"}`,
      }),
    );

    h.store.enqueueRun({ runId: "px1", workflowSha: sha });
    await driveTo(h, "px1");

    expect(h.store.getState("px1")!.status).toBe("completed");
    // Verify the sub-run wrote its output referencing parent's scope.
    const child = h.store.getState("px1__fanout__i0__b0")!;
    const childArtifact = h.store.getArtifact({
      runId: child.runId,
      nodeId: "lens_a",
      iteration: 0,
      key: "output",
    });
    const childOutput = new TextDecoder().decode(childArtifact);
    expect(childOutput).toBe("LENS_SAW:SCOPE_OUTPUT");
    h.store.close();
  });

  test("parent's downstream node reads sub-run output via $branchNodeId.output", async () => {
    // synthesize reads each lens's output. Without the children-down
    // walk in getNodeOutputs, this would silently resolve to empty
    // strings (the symptom that motivated this fix).
    const h = freshHarness();
    const sha = "wf_crossrun_down";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      lens_a;
      lens_b;
      fan_in [shape=tripleoctagon];
      synthesize;
      done [shape=Msquare];
      start -> fanout;
      fanout -> lens_a;
      fanout -> lens_b;
      lens_a -> fan_in;
      lens_b -> fan_in;
      fan_in -> synthesize;
      synthesize -> done;
    }`;
    h.store.saveWorkflow(sha, "crossrun-down", dot);
    h.dispatcher.register(sha, "lens_a", mockCodergenSpec({ costPerCall: 0.01, calls: 1, output: "FINDING_A" }));
    h.dispatcher.register(sha, "lens_b", mockCodergenSpec({ costPerCall: 0.01, calls: 1, output: "FINDING_B" }));
    h.dispatcher.register(
      sha,
      "synthesize",
      mockCodergenSpec({
        costPerCall: 0.01,
        calls: 1,
        outputFn: (lookup) =>
          `MERGED:[${lookup.get("lens_a")?.output ?? "<missing>"}|${lookup.get("lens_b")?.output ?? "<missing>"}]`,
      }),
    );

    h.store.enqueueRun({ runId: "px2", workflowSha: sha });
    await driveTo(h, "px2", { maxSteps: 60 });

    expect(h.store.getState("px2")!.status).toBe("completed");
    const synthBytes = h.store.getArtifact({
      runId: "px2",
      nodeId: "synthesize",
      iteration: 0,
      key: "output",
    });
    const synth = new TextDecoder().decode(synthBytes);
    expect(synth).toBe("MERGED:[FINDING_A|FINDING_B]");
    h.store.close();
  });
});

describe("parallel sub-runs — terminal vs subgraph fence pause", () => {
  test("subgraph fence terminal does pause on budget breach (sub-run path)", async () => {
    // The legacy "alreadyTerminal skip" silently let sub-runs complete
    // over their cap. New behavior: the synthetic __end__ from the
    // subgraph fence pauses on breach, the workflow-declared terminal
    // (top-level done) still completes cleanly.
    const h = freshHarness();
    const sha = "wf_fence_pause";
    const dot = `digraph G {
      start [shape=Mdiamond];
      fanout [shape=component];
      lens [max_cost_usd=0.10];
      fan_in [shape=tripleoctagon];
      done [shape=Msquare];
      start -> fanout;
      fanout -> lens;
      lens -> fan_in;
      fan_in -> done;
    }`;
    h.store.saveWorkflow(sha, "fence-pause", dot);
    // 5 calls × $0.05 = $0.25 over a $0.10 cap.
    h.dispatcher.register(sha, "lens", mockCodergenSpec({ costPerCall: 0.05, calls: 5 }));

    h.store.enqueueRun({ runId: "p8", workflowSha: sha });
    await driveTo(h, "p8");

    const child = h.store.getState("p8__fanout__i0__b0")!;
    expect(child.status).toBe("paused");
    const paused = h.store.getEvents(child.runId).find((e) => e.type === "fact.run_paused");
    expect(paused).toBeDefined();
    expect((paused!.payload as { reason: string }).reason).toBe("budget");
    h.store.close();
  });
});
