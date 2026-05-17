// End-to-end integration test for fan_in LLM evaluation.
//
// Exercises the path where a tripleoctagon carries prompt= and a stub
// LlmFanInDelegate picks the winner from three branch candidates.
// Verifies:
//   - The delegate is invoked with branch outputs populated from the
//     store's artifact namespace.
//   - run_state.routing["fan_in.pick.winner"] equals the id the
//     delegate returned.
//   - fact.fan_in.completed carries evaluator:"llm".
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

// Three-branch DOT with prompt= on the tripleoctagon.
const LLM_FAN_IN_DOT = `
digraph G {
  start  [shape=Mdiamond]
  fanout [shape=component]
  a      [prompt="investigate severity A"]
  b      [prompt="investigate severity B"]
  c      [prompt="investigate severity C"]
  pick   [shape=tripleoctagon, prompt="pick the highest-severity branch"]
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

describe("fan_in LLM evaluation end-to-end", () => {
  test("three-branch parallel where LLM picks highest-severity branch", async () => {
    const capturedInputs: LlmFanInInput[] = [];

    // Delegate that picks whichever branch has "critical" in its output.
    const delegate: LlmFanInDelegate = async (input) => {
      capturedInputs.push(input);
      let chosen = input.candidates[0]?.branchId ?? "a";
      for (const cand of input.candidates) {
        const out = input.branchOutputs.get(cand.branchId) ?? "";
        if (out.includes("critical")) {
          chosen = cand.branchId;
          break;
        }
      }
      return { winner: chosen, tokens: 100, costUsd: 0.005 };
    };

    const sha = "wf_llm_fan_in";
    const harness = freshHarness(sha, delegate);
    harness.store.saveWorkflow(sha, "llm-fan-in", LLM_FAN_IN_DOT);

    const runId = "run_llm_fan_in";
    harness.store.enqueueRun({ runId, workflowSha: sha });

    await driveTo(harness, runId);

    const final = harness.store.getState(runId)!;
    expect(final.status).toBe("completed");

    // Delegate was called once (at the fan-in node).
    expect(capturedInputs).toHaveLength(1);
    const inp = capturedInputs[0]!;
    expect(inp.candidates).toHaveLength(3);
    expect(inp.prompt).toBe("pick the highest-severity branch");

    // Branch b has "critical" in its output — delegate should have
    // received it and picked "b".
    const bOutput = inp.branchOutputs.get("b") ?? "";
    expect(bOutput).toContain("critical");

    // Winner is "b" — the critical branch.
    const winner = final.routing["fan_in.pick.winner"];
    expect(winner).toBe("b");

    // fact.fan_in.completed carries evaluator:"llm".
    const events = harness.store.getEvents(runId);
    const fanInCompleted = events.find((e) => e.type === "fan_in.completed");
    expect(fanInCompleted).toBeDefined();
    expect((fanInCompleted!.payload as Record<string, unknown>)["evaluator"]).toBe("llm");
    expect((fanInCompleted!.payload as Record<string, unknown>)["winner"]).toBe("b");

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
    const delegate: LlmFanInDelegate = async (input) => {
      delegateCalls.push(1);
      return { winner: input.candidates[0]?.branchId ?? "a", tokens: 0, costUsd: 0 };
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

    harness2.store.close();
  });
});
