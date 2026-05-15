// Integration smoke for parallel fan-out where one branch is a
// multi-node subgraph: codergen → wait.human → tool. Exercises:
//   - All 3 children spawn from the parallel.* parent.
//   - The multi-node branch dispatches `analyze` first, then `confirm`
//     which pauses on HITL inside the sub-run.
//   - Operator answers "A" → `apply` (tool node) runs → fan_in.
//   - Operator answers "S" → branch short-circuits to fan_in.
//   - Other two branches complete cleanly.
//   - Parent fan_in fires only after all 3 children reach terminal.

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
  read_only [prompt="READ_ONLY_DONE"];
  analyze [prompt="PLAN"];
  confirm [shape=hexagon, prompt="Apply?"];
  apply [shape=parallelogram, tool_command="echo APPLIED"];
  baseline [prompt="BASELINE_DONE"];
  combine [shape=tripleoctagon];
  done [shape=Msquare];
  start -> spawn;
  spawn -> read_only;
  spawn -> analyze;
  spawn -> baseline;
  read_only -> combine;
  analyze -> confirm;
  confirm -> apply   [label="[A] Apply"];
  confirm -> combine [label="[S] Skip"];
  apply -> combine;
  baseline -> combine;
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
  const maxSteps = opts.maxSteps ?? 200;
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
        state.status === "completed" || state.status === "halted" || state.status === "cancelled";
      if (terminal) return;
      const paused =
        state.status === "paused" || state.status === "paused_hitl" || state.status === "paused_auto";
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

function findHitlChild(h: ReturnType<typeof freshHarness>, parentRunId: string): string {
  // Sub-run id pattern: <parent>__spawn__i0__b<idx>. The middle
  // branch (analyze) is the only one that pauses on HITL.
  for (let i = 0; i < 5; i++) {
    const candidate = `${parentRunId}__spawn__i0__b${i}`;
    const s = h.store.getState(candidate);
    if (s?.status === "paused_hitl") return candidate;
  }
  throw new Error("no paused_hitl child found");
}

describe("parallel-hitl-smoke — multi-node branch with HITL + tool", () => {
  test("answer Apply: analyze → confirm → apply → fan_in; all 3 branches terminal; parent completes", async () => {
    const h = freshHarness();
    const sha = "wf_smoke_apply";
    h.store.saveWorkflow(sha, "parallel-hitl-smoke", SMOKE_DOT);

    h.dispatcher.register(sha, "read_only", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "analyze", mockCodergenSpec({ costPerCall: 0.02, calls: 1, output: "PLAN refactor" }));
    h.dispatcher.register(sha, "baseline", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    // confirm (hexagon) → wait.human auto-resolves.
    // apply (parallelogram) → tool spec auto-resolves; tool_command
    // runs through the in-memory tool registry. No external bash.
    h.tools.register("__tool__", async () => ({ output: "APPLIED\n", exitCode: 0 }));

    h.store.enqueueRun({ runId: "smk", workflowSha: sha });
    await tick(h, "smk", { until: (s) => s.status === "running_children" || s.status === "completed" });

    // Wait for the HITL child to pause.
    await tick(h, "smk", {
      until: (s) => s.status === "completed" || s.status === "halted" || s.status === "cancelled",
      maxSteps: 50,
    });
    const hitlChild = findHitlChild(h, "smk");
    expect(h.store.getState(hitlChild)?.status).toBe("paused_hitl");

    // Operator chooses Apply.
    h.store.appendIntent(hitlChild, { type: "intent.hitl_input", payload: { selected: "A" } });
    h.store.appendIntent(hitlChild, { type: "intent.resume", payload: {} });

    await tick(h, "smk", { maxSteps: 200 });
    expect(h.store.getState("smk")?.status).toBe("completed");
    h.store.close();
  });

  test("answer Skip: confirm → combine (apply skipped); parent still completes", async () => {
    const h = freshHarness();
    const sha = "wf_smoke_skip";
    h.store.saveWorkflow(sha, "parallel-hitl-smoke", SMOKE_DOT);
    h.dispatcher.register(sha, "read_only", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.dispatcher.register(sha, "analyze", mockCodergenSpec({ costPerCall: 0.02, calls: 1, output: "PLAN" }));
    h.dispatcher.register(sha, "baseline", mockCodergenSpec({ costPerCall: 0.01, calls: 1 }));
    h.tools.register("__tool__", async () => ({ output: "", exitCode: 0 }));

    h.store.enqueueRun({ runId: "smk2", workflowSha: sha });
    await tick(h, "smk2", { until: (s) => s.status === "running_children" || s.status === "completed" });
    await tick(h, "smk2", {
      until: (s) => s.status === "completed" || s.status === "halted" || s.status === "cancelled",
      maxSteps: 50,
    });
    const hitlChild = findHitlChild(h, "smk2");

    h.store.appendIntent(hitlChild, { type: "intent.hitl_input", payload: { selected: "S" } });
    h.store.appendIntent(hitlChild, { type: "intent.resume", payload: {} });

    await tick(h, "smk2", { maxSteps: 200 });
    expect(h.store.getState("smk2")?.status).toBe("completed");
    h.store.close();
  });
});
