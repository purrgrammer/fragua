// Integration smoke for parallel + HITL UX.
//
// Three branches in parallel, mixed concerns:
//   - branch_hitl    (hexagon)   → paused_hitl on first dispatch
//   - branch_quick   (codergen)  → runs to completion
//   - branch_budget  (codergen)  → paused on budget breach
//
// Drives every operator-visible state in the sub-run lifecycle so the
// UI plan (sub-runs first class) has a deterministic fixture to assert
// against. Mirrors the .dot at .swarm/workflows/parallel-hitl-smoke.dot,
// but inlines the source so it doesn't need provider credentials.

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { mockCodergenSpec } from "./helpers.ts";

const SMOKE_DOT = `digraph parallel_hitl_smoke {
  start [shape=Mdiamond];
  spawn [shape=component, join_policy="wait_all"];
  branch_hitl   [shape=hexagon, prompt="Approve?"];
  branch_quick  [prompt="Reply DONE"];
  branch_budget [prompt="count to 100", max_cost_usd="0.05"];
  combine [shape=tripleoctagon];
  done [shape=Msquare];
  start -> spawn;
  spawn -> branch_hitl;
  spawn -> branch_quick;
  spawn -> branch_budget;
  branch_hitl   -> combine [label="[A] Approve"];
  branch_hitl   -> combine [label="[R] Reject"];
  branch_quick  -> combine;
  branch_budget -> combine;
  combine -> done;
}`;

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

async function tick(
  h: ReturnType<typeof freshHarness>,
  runId: string,
  opts: { maxSteps?: number; until?: (state: NonNullable<ReturnType<SqliteStore["getState"]>>) => boolean } = {},
): Promise<void> {
  const ac = new AbortController();
  const maxSteps = opts.maxSteps ?? 50;
  for (let i = 0; i < maxSteps; i++) {
    wakePending(h.store);
    if (opts.until != null) {
      const state = h.store.getState(runId);
      if (state != null && opts.until(state)) return;
    }
    const claimed = h.store.claimNextRun(8);
    if (claimed == null) {
      const state = h.store.getState(runId);
      if (state == null) return;
      const terminal =
        state.status === "completed" ||
        state.status === "halted" ||
        state.status === "cancelled";
      if (terminal) return;
      const paused =
        state.status === "paused" ||
        state.status === "paused_hitl" ||
        state.status === "paused_auto";
      if (paused && opts.until == null) return;
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

function childRunId(parent: string, branchIdx: number): string {
  return `${parent}__spawn__i0__b${branchIdx}`;
}

describe("parallel-hitl-smoke — full operator lifecycle", () => {
  test("parent fans out 3 children; one HITL-paused, one done, one budget-paused; operator drives all to completion", async () => {
    const h = freshHarness();
    const sha = "wf_smoke";
    h.store.saveWorkflow(sha, "parallel-hitl-smoke", SMOKE_DOT);

    // The hexagon (branch_hitl) auto-resolves to wait.human via the
    // auto-dispatcher resolver. The two codergen branches need explicit
    // mock specs.
    h.dispatcher.register(sha, "branch_quick", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    // branch_budget: 10 calls × $0.05 = $0.50, well over the $0.05 cap →
    // pauses on budget after one or two calls.
    h.dispatcher.register(sha, "branch_budget", mockCodergenSpec({ costPerCall: 0.05, calls: 10 }));
    // combine (the fan_in) is a tripleoctagon → resolves to fan_in spec
    // automatically; needs no explicit register.

    h.store.enqueueRun({ runId: "smoke1", workflowSha: sha });

    // Phase 1: fan out, settle into mixed state.
    await tick(h, "smoke1", { maxSteps: 100 });

    const parent = h.store.getState("smoke1")!;
    expect(parent.status).toBe("running_children");

    const hitlChild = h.store.getState(childRunId("smoke1", 0))!;
    const quickChild = h.store.getState(childRunId("smoke1", 1))!;
    const budgetChild = h.store.getState(childRunId("smoke1", 2))!;

    expect(hitlChild.status).toBe("paused_hitl");
    expect(quickChild.status).toBe("completed");
    expect(budgetChild.status).toBe("paused");

    // Budget child has paused with reason "budget".
    const budgetPausedEvent = h.store
      .getEvents(budgetChild.runId)
      .find((e) => e.type === "fact.run_paused");
    expect(budgetPausedEvent).toBeDefined();
    expect((budgetPausedEvent!.payload as { reason: string }).reason).toBe("budget");

    // While children are still active, the parent's projection has
    // NOT folded their costs yet — that batch-fires at fan-in. So we
    // verify cost rollup at the end of phase 3 instead.

    // Phase 2: operator raises the budget child's cap and resumes.
    h.store.appendIntent(budgetChild.runId, {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 1.0 },
    });
    h.store.appendIntent(budgetChild.runId, { type: "intent.resume", payload: {} });

    await tick(h, "smoke1", {
      maxSteps: 100,
      until: (s) => {
        const c = h.store.getState(budgetChild.runId);
        return c != null && (c.status === "completed" || c.status === "halted" || c.status === "cancelled");
      },
    });

    expect(h.store.getState(budgetChild.runId)!.status).toBe("completed");
    // Parent still running_children — branch_hitl is still paused_hitl.
    expect(h.store.getState("smoke1")!.status).toBe("running_children");
    expect(h.store.getState(hitlChild.runId)!.status).toBe("paused_hitl");

    // Phase 3: operator answers the HITL gate with "A".
    h.store.appendIntent(hitlChild.runId, {
      type: "intent.hitl_input",
      payload: { selected: "A" },
    });
    h.store.appendIntent(hitlChild.runId, { type: "intent.resume", payload: {} });

    await tick(h, "smoke1", { maxSteps: 100 });

    // Everything completes.
    expect(h.store.getState(hitlChild.runId)!.status).toBe("completed");
    expect(h.store.getState("smoke1")!.status).toBe("completed");

    // Cost rollup: parent accumulated quick (0.01) + budget (>= 0.05) at
    // minimum from sub-runs. HITL child's cost is 0 (wait.human is free).
    expect(h.store.getState("smoke1")!.metrics.totalCostUsd).toBeGreaterThan(0.05);

    h.store.close();
  });

  test("rejecting HITL still completes the branch (both edges route to fan_in)", async () => {
    const h = freshHarness();
    const sha = "wf_smoke_reject";
    h.store.saveWorkflow(sha, "smoke-reject", SMOKE_DOT);
    h.dispatcher.register(sha, "branch_quick", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "branch_budget", mockCodergenSpec({ costPerCall: 0.05, calls: 10 }));

    h.store.enqueueRun({ runId: "smoke2", workflowSha: sha });
    await tick(h, "smoke2", { maxSteps: 100 });

    const hitlChild = h.store.getState(childRunId("smoke2", 0))!;
    const budgetChild = h.store.getState(childRunId("smoke2", 2))!;
    expect(hitlChild.status).toBe("paused_hitl");

    // Raise budget so the budget branch finishes.
    h.store.appendIntent(budgetChild.runId, {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 1.0 },
    });
    h.store.appendIntent(budgetChild.runId, { type: "intent.resume", payload: {} });

    // Reject the HITL.
    h.store.appendIntent(hitlChild.runId, {
      type: "intent.hitl_input",
      payload: { selected: "R" },
    });
    h.store.appendIntent(hitlChild.runId, { type: "intent.resume", payload: {} });

    await tick(h, "smoke2", { maxSteps: 100 });

    expect(h.store.getState(hitlChild.runId)!.status).toBe("completed");
    expect(h.store.getState("smoke2")!.status).toBe("completed");
    h.store.close();
  });
});
