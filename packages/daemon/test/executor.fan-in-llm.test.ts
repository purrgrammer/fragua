// End-to-end integration test for fan_in LLM synthesis.
//
// Exercises the path where a tripleoctagon carries prompt= and a stub
// LlmFanInDelegate returns a synthesised document. Verifies:
//   - The delegate is invoked with branch outputs populated from the
//     store's artifact namespace.
//   - The synthesised document is captured as the fan-in node's
//     `output` artifact and reaches downstream nodes via
//     `$<fanInId>.output` substitution.
//   - fact.fan_in.completed carries evaluator:"llm" and no winner key.
//   - The run completes successfully.

import { describe, expect, test } from "bun:test";
import type { LlmFanInDelegate, LlmFanInInput } from "@swarm/core/handler";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { mockCodergenSpec } from "./helpers.ts";

// Three-branch DOT with prompt= on the tripleoctagon plus a downstream
// codergen that reads the synthesised output.
const LLM_FAN_IN_DOT = `
digraph G {
  start  [shape=Mdiamond]
  fanout [shape=component]
  a      [prompt="investigate severity A"]
  b      [prompt="investigate severity B"]
  c      [prompt="investigate severity C"]
  pick   [shape=tripleoctagon, prompt="integrate findings into a single review"]
  done   [shape=Msquare]
  start -> fanout
  fanout -> a
  fanout -> b
  fanout -> c
  a -> pick
  b -> pick
  c -> pick
  pick -> done
}
`;

function freshHarness(sha: string, delegate: LlmFanInDelegate) {
  const store = new SqliteStore({ path: ":memory:" });
  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store, fanInLlmDelegate: delegate }));
  // Register branch stubs upfront so sub-runs that claim branch
  // nodes find their specs immediately.
  dispatcher.register(sha, "a", mockCodergenSpec({ output: "severity:low — minor issue detected" }));
  dispatcher.register(sha, "b", mockCodergenSpec({ output: "severity:critical — SQL injection found" }));
  dispatcher.register(sha, "c", mockCodergenSpec({ output: "severity:medium — performance regression" }));
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

async function driveTo(harness: ReturnType<typeof freshHarness>, runId: string, maxSteps = 40): Promise<void> {
  const ac = new AbortController();
  for (let i = 0; i < maxSteps; i++) {
    wakePending(harness.store);
    const claimed = harness.store.claimNextRun(8);
    if (claimed == null) {
      const state = harness.store.getState(runId);
      if (state == null) return;
      const terminal = ["completed", "halted", "cancelled"].includes(state.status);
      if (terminal) return;
      continue;
    }

    await runOne(claimed.runId, {
      store: harness.store,
      dispatcher: harness.dispatcher,
      registry: harness.registry,
      tools: harness.tools,
      llmCall: harness.llmCall,
      maxConcurrentRuns: 8,
      maxTurnsForTesting: 30,
      shutdownSignal: ac.signal,
    });
  }
}

describe("fan_in LLM synthesis end-to-end", () => {
  test("three-branch parallel where LLM synthesises a unified document from all branch outputs", async () => {
    const capturedInputs: LlmFanInInput[] = [];
    const synthesised =
      "# Combined Review\n\n## Scope\nThree lenses ran in parallel.\n\n## Findings\n1. critical — SQL injection (from branch_b)\n2. medium — perf regression (branch_c)\n3. low — minor issue (branch_a)";

    const delegate: LlmFanInDelegate = async (input) => {
      capturedInputs.push(input);
      return { output: synthesised, tokens: 100, costUsd: 0.005 };
    };

    const sha = "wf_llm_fan_in";
    const harness = freshHarness(sha, delegate);
    harness.store.saveWorkflow(sha, "llm-fan-in", LLM_FAN_IN_DOT);

    const runId = "run_llm_fan_in";
    harness.store.enqueueRun({ runId, workflowSha: sha });

    await driveTo(harness, runId);

    const final = harness.store.getState(runId)!;
    expect(final.status).toBe("completed");

    // Delegate was called once at the fan-in node, with all three branches.
    expect(capturedInputs).toHaveLength(1);
    const inp = capturedInputs[0]!;
    expect(inp.candidates).toHaveLength(3);
    expect(inp.prompt).toBe("integrate findings into a single review");
    // Branch outputs are populated from the store's artifact namespace.
    expect(inp.branchOutputs.get("b") ?? "").toContain("critical");

    // No winner key written for the LLM synthesis path.
    expect(final.routing["fan_in.pick.winner"]).toBeUndefined();

    // fact.fan_in.completed carries evaluator:"llm" and no winner field.
    const events = harness.store.getEvents(runId);
    const fanInCompleted = events.find((e) => e.type === "fan_in.completed");
    expect(fanInCompleted).toBeDefined();
    const payload = fanInCompleted!.payload as Record<string, unknown>;
    expect(payload["evaluator"]).toBe("llm");
    expect(payload["outputBytes"]).toBe(synthesised.length);
    expect(payload).not.toHaveProperty("winner");

    harness.store.close();
  });

  test("synthesised output is captured as the fan-in's `output` artifact (downstream $<fanInId>.output read path)", async () => {
    // The handler-level test (packages/core/test/handler/fan-in.test.ts)
    // proves the synthesis output flows into result.outputRef via
    // ctx.artifacts.put. Here we verify it round-trips through the
    // store: after the run completes, the fan-in node's `output`
    // artifact can be read back. The executor's nodeOutputs fold
    // (packages/store/src/store.ts:getNodeOutputs) walks the same
    // fact.node_completed payload["outputRef"] used by every other
    // codergen-style node, so any downstream `$<fanInId>.output`
    // substitution sees the synthesised text.
    const synthesised = "## Synthesised review\n\nCritical: SQL injection. Recommend immediate fix.";
    const delegate: LlmFanInDelegate = async () => ({ output: synthesised, tokens: 10, costUsd: 0.001 });

    const sha = "wf_llm_fan_in_artifact";
    const harness = freshHarness(sha, delegate);
    harness.store.saveWorkflow(sha, "llm-fan-in-artifact", LLM_FAN_IN_DOT);

    const runId = "run_artifact";
    harness.store.enqueueRun({ runId, workflowSha: sha });
    await driveTo(harness, runId);

    expect(harness.store.getState(runId)!.status).toBe("completed");

    // 1. The fact.node_completed for `pick` carries outputRef pointing
    //    at the fan-in's `output` artifact.
    const events = harness.store.getEvents(runId);
    const pickCompleted = events.find(
      (e) => e.type === "fact.node_completed" && (e.payload as Record<string, unknown>)["nodeId"] === "pick",
    );
    expect(pickCompleted).toBeDefined();
    expect((pickCompleted!.payload as Record<string, unknown>)["outputRef"]).toBe("pick:output");

    // 2. The artifact bytes round-trip the synthesised document.
    const bytes = harness.store.getArtifact({
      runId,
      nodeId: "pick",
      iteration: 0,
      key: "output",
    });
    expect(new TextDecoder().decode(bytes)).toBe(synthesised);

    // 3. The store's getNodeOutputs fold — the same surface the
    //    executor hands to handlers as ctx.nodeOutputs for downstream
    //    `$<fanInId>.output` substitution — sees the synthesised text
    //    under `pick`.
    const nodeOutputs = harness.store.getNodeOutputs(runId);
    expect(nodeOutputs.get("pick")?.output).toBe(synthesised);

    harness.store.close();
  });

  test("heuristic path (no prompt) still works when delegate is configured", async () => {
    // When the fan-in node has no prompt=, the heuristic runs regardless
    // of whether fanInLlmDelegate is configured.
    const HEURISTIC_DOT = `
      digraph G {
        start  [shape=Mdiamond]
        fanout [shape=component]
        a      [prompt="a"]
        b      [prompt="b"]
        pick   [shape=tripleoctagon]
        done   [shape=Msquare]
        start -> fanout -> a -> pick -> done
        fanout -> b -> pick
      }
    `;

    const delegateCalls: number[] = [];
    const delegate: LlmFanInDelegate = async (_input) => {
      delegateCalls.push(1);
      return { output: "should-not-be-called", tokens: 0, costUsd: 0 };
    };

    const sha = "wf_heuristic_with_delegate";
    const store = new SqliteStore({ path: ":memory:" });
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store, fanInLlmDelegate: delegate }));
    store.saveWorkflow(sha, "heuristic-with-delegate", HEURISTIC_DOT);

    const llmCall: handler.LlmCallFn = async () => ({
      content: "",
      tokens: 0,
      costUsd: 0,
      model: "stub",
    });
    const harness2 = {
      store,
      dispatcher,
      tools: new handler.InMemoryToolRegistry(),
      llmCall,
      registry: new AbortRegistry(),
    };

    const runId = "run_heuristic";
    harness2.store.enqueueRun({ runId, workflowSha: sha });

    await driveTo(harness2 as ReturnType<typeof freshHarness>, runId);

    const final = harness2.store.getState(runId)!;
    expect(final.status).toBe("completed");
    // Delegate was NOT called — heuristic path ran instead.
    expect(delegateCalls).toHaveLength(0);

    const events = harness2.store.getEvents(runId);
    const fanInCompleted = events.find((e) => e.type === "fan_in.completed");
    expect(fanInCompleted).toBeDefined();
    expect((fanInCompleted!.payload as Record<string, unknown>)["evaluator"]).toBe("heuristic");
    // Heuristic path keeps the winner key.
    expect(fanInCompleted!.payload as Record<string, unknown>).toHaveProperty("winner");

    harness2.store.close();
  });
});
