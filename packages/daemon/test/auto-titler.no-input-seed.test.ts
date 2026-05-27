// Failing test for Part A: no-input runs should still produce a non-empty
// title seed from the workflow name and the titler should be invoked.
//
// Current behaviour (bug): when there are no typed inputs, inputLines is ""
// → seed stays "" → titleRun skips the backend call → title stays null.
//
// Desired behaviour: seed = "workflow=<name>" when there are no typed inputs
// → backend is called → title is set.

import { describe, expect, test } from "bun:test";
import type { SummariseInput, SummariseOutput, SummariserBackend } from "@fragua/core";
import { AbortRegistry } from "../src/abort-registry.ts";
import { AutoTitler } from "../src/auto-titler.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

const okOut = (text: string): SummariseOutput => ({
  text,
  ok: true,
  provider: "stub",
  model: "tiny",
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  duration_ms: 1,
});

class CapturingBackend implements SummariserBackend {
  calls: SummariseInput[] = [];
  async summarise(input: SummariseInput): Promise<SummariseOutput> {
    this.calls.push(input);
    return okOut(`titled:${input.input}`);
  }
}

describe("AutoTitler — no-input run gets a title seed from workflow name", () => {
  test("executor: no typed inputs → seed = 'workflow=<name>', backend invoked, title set", async () => {
    const yaml = `name: deploy\ngoal: "deploy the app"\nsteps:\n  start: {type: llm, prompt: hi}\n`;
    const r = rig({ yaml, name: "deploy" });
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");

    // Enqueue with NO typed inputs (simulates a scheduled or bare run)
    enqueue(r, "r1", "start");

    const backend = new CapturingBackend();
    const ctrl = new AbortController();
    const titler = new AutoTitler({ backend, store: r.store, shutdownSignal: ctrl.signal });
    const registry = new AbortRegistry();

    const executorOpts: Parameters<typeof runOne>[1] = {
      store: r.store,
      dispatcher: r.dispatcher,
      registry,
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 4,
      shutdownSignal: ctrl.signal,
      maxTurnsForTesting: 10,
      autoTitler: titler,
    };
    r.store.claimNextRun(4);
    await runOne("r1", executorOpts);
    await titler.drain();

    // The backend must have been called — seed was not empty
    // FAILS today because the executor only builds a seed when inputLines !== ""
    expect(backend.calls).toHaveLength(1);

    // The seed must contain the workflow name
    const seed = backend.calls[0]!.input;
    expect(seed).toContain("workflow=deploy");

    // A title must have been written to run_state
    expect(r.store.getState("r1")?.title).not.toBeNull();

    ctrl.abort();
    r.store.close();
  });
});
