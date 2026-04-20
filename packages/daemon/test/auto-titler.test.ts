// AutoTitler — unit + integration sanity.
//
// Integration with the executor is covered by constructing a tiny
// in-memory workflow, enqueuing a run with `routing.input`, and running
// the executor for one turn so `fact.run_started` fires. The titler's
// SummariserBackend is a stub so no pi-ai / network calls happen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SummariseInput, SummariseOutput, SummariserBackend } from "@swarm/core";
import { AbortRegistry } from "../src/abort-registry.ts";
import { AutoTitler } from "../src/auto-titler.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

class StubBackend implements SummariserBackend {
  calls: SummariseInput[] = [];
  constructor(private readonly out: (input: SummariseInput) => SummariseOutput) {}
  async summarise(input: SummariseInput): Promise<SummariseOutput> {
    this.calls.push(input);
    if (input.emit) {
      await input.emit(
        "summary.started",
        { purpose: input.purpose, provider: "stub", model: "tiny" },
        input.synthetic_node_id,
      );
    }
    const res = this.out(input);
    if (input.emit) {
      await input.emit(
        "summary.completed",
        {
          purpose: input.purpose,
          provider: "stub",
          model: "tiny",
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: res.cost_usd,
          duration_ms: res.duration_ms,
          output_text: res.text,
        },
        input.synthetic_node_id,
      );
    }
    return res;
  }
}

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

const failOut: SummariseOutput = {
  text: "",
  ok: false,
  error: "no api key",
  provider: "stub",
  model: "tiny",
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  duration_ms: 1,
};

describe("AutoTitler — unit", () => {
  let abortCtrl: AbortController;
  beforeEach(() => {
    abortCtrl = new AbortController();
  });
  afterEach(() => abortCtrl.abort());

  test("titleRun with a non-empty input projects title onto run_state", async () => {
    const r = rig();
    r.store.enqueueRun({
      runId: "r1",
      workflowSha: r.workflowSha,
      initialRouting: { input: "rename foo to bar" },
    });

    const backend = new StubBackend(() => okOut("Rename foo → bar"));
    const titler = new AutoTitler({
      backend,
      store: r.store,
      shutdownSignal: abortCtrl.signal,
    });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "rename foo to bar" });
    await titler.drain();

    expect(r.store.getState("r1")?.title).toBe("Rename foo → bar");
    const events = r.store.getEvents("r1");
    expect(events.some((e) => e.type === "run.title_generated")).toBe(true);
    expect(events.some((e) => e.type === "summary.started")).toBe(true);
    expect(events.some((e) => e.type === "summary.completed")).toBe(true);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.input).toBe("rename foo to bar");

    r.store.close();
  });

  test("empty input → no summariser call, no title", async () => {
    const r = rig();
    r.store.enqueueRun({ runId: "r1", workflowSha: r.workflowSha, initialRouting: {} });
    const backend = new StubBackend(() => okOut("never"));
    const titler = new AutoTitler({ backend, store: r.store, shutdownSignal: abortCtrl.signal });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "" });
    await titler.drain();
    expect(backend.calls).toHaveLength(0);
    expect(r.store.getState("r1")?.title).toBeNull();
    r.store.close();
  });

  test("backend failure leaves title null and no run.title_generated", async () => {
    const r = rig();
    r.store.enqueueRun({ runId: "r1", workflowSha: r.workflowSha, initialRouting: { input: "x" } });
    const backend = new StubBackend(() => failOut);
    const titler = new AutoTitler({ backend, store: r.store, shutdownSignal: abortCtrl.signal });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "x" });
    await titler.drain();

    expect(r.store.getState("r1")?.title).toBeNull();
    const events = r.store.getEvents("r1");
    expect(events.some((e) => e.type === "run.title_generated")).toBe(false);
    expect(events.some((e) => e.type === "summary.completed")).toBe(true);
    r.store.close();
  });

  test("disabled → fire-and-forget is a no-op", async () => {
    const r = rig();
    r.store.enqueueRun({ runId: "r1", workflowSha: r.workflowSha, initialRouting: { input: "x" } });
    const backend = new StubBackend(() => okOut("unused"));
    const titler = new AutoTitler({
      backend,
      store: r.store,
      shutdownSignal: abortCtrl.signal,
      enabled: false,
    });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "x" });
    await titler.drain();
    expect(backend.calls).toHaveLength(0);
    r.store.close();
  });

  test("title longer than maxTitleChars is clipped", async () => {
    const r = rig();
    r.store.enqueueRun({ runId: "r1", workflowSha: r.workflowSha, initialRouting: { input: "x" } });
    const long = "a".repeat(500);
    const backend = new StubBackend(() => okOut(long));
    const titler = new AutoTitler({
      backend,
      store: r.store,
      shutdownSignal: abortCtrl.signal,
      maxTitleChars: 10,
    });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "x" });
    await titler.drain();
    expect(r.store.getState("r1")?.title).toBe("a".repeat(10));
    r.store.close();
  });

  test("drain awaits every in-flight title call", async () => {
    const r = rig();
    r.store.enqueueRun({ runId: "r1", workflowSha: r.workflowSha, initialRouting: { input: "x" } });
    r.store.enqueueRun({ runId: "r2", workflowSha: r.workflowSha, initialRouting: { input: "y" } });

    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const backend: SummariserBackend = {
      async summarise(input) {
        await new Promise<void>((ok) => {
          if (input.run_id === "r1") resolveFirst = ok;
          else resolveSecond = ok;
        });
        return okOut(`T:${input.run_id}`);
      },
    };
    const titler = new AutoTitler({ backend, store: r.store, shutdownSignal: abortCtrl.signal });
    titler.titleRun({ runId: "r1", workflowSha: r.workflowSha, input: "x" });
    titler.titleRun({ runId: "r2", workflowSha: r.workflowSha, input: "y" });

    const drained = titler.drain();
    setTimeout(() => {
      resolveFirst?.();
      resolveSecond?.();
    }, 5);
    await drained;

    expect(r.store.getState("r1")?.title).toBe("T:r1");
    expect(r.store.getState("r2")?.title).toBe("T:r2");
    r.store.close();
  });
});

describe("AutoTitler — executor integration", () => {
  test("titleRun fires once per run right after fact.run_started", async () => {
    const dot = `digraph wf { graph[goal="rename things"]; start [shape=Mdiamond]; done [shape=Msquare]; start -> done; }`;
    const r = rig({ dot });
    registerTerminalEcho(r.dispatcher, r.workflowSha, "start");
    // r1 is enqueued with no input; the titler should skip it.
    enqueue(r, "r1", "start");

    const backend = new StubBackend((input) => okOut(`goal=${input.goal}`));
    const ctrl = new AbortController();
    const titler = new AutoTitler({ backend, store: r.store, shutdownSignal: ctrl.signal });
    const registry = new AbortRegistry();

    // r2 has an explicit routing.input so the titler should summarise it.
    r.store.enqueueRun({
      runId: "r2",
      workflowSha: r.workflowSha,
      initialRouting: { start_node: "start", input: "please rename things" },
    });

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
    r.store.claimNextRun(4); // claim r1
    await runOne("r1", executorOpts);
    r.store.claimNextRun(4); // claim r2
    await runOne("r2", executorOpts);
    await titler.drain();

    // r1 had no input → no backend call, no title
    expect(r.store.getState("r1")?.title).toBeNull();
    // r2 had input → backend call fires, goal flows through, title set
    expect(r.store.getState("r2")?.title).toBe("goal=rename things");
    expect(backend.calls).toHaveLength(1);

    ctrl.abort();
    r.store.close();
  });
});
