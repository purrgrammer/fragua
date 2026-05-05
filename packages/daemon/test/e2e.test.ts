// End-to-end integration: web server writes intent → store → daemon runs →
// UI reads projection through /runs/*.
//
// M5 bar: fresh DB → enqueue a run → daemon executes → completed state is
// visible via the same GET /runs/:id endpoint the UI calls.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as handler from "@swarm/core/handler";
import { createServer } from "@swarm/server";
import { SqliteStore } from "@swarm/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";

describe("M5 end-to-end — fresh store to completed run via HTTP", () => {
  test("enqueue via POST /runs → daemon runs → GET /runs/:id shows success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-e2e-"));
    const store = new SqliteStore({ path: join(dir, "swarm.db") });
    store.saveWorkflow("wf-sha", "echo-wf", "digraph Echo { start -> __end__ }");

    const dispatcher = new Dispatcher();
    dispatcher.register("wf-sha", "start", {
      kind: "step",
      sideEffect: "none",
      maxMs: 1_000,
      handler: async () => ({
        kind: "transition",
        nextNode: "__end__",
        tokens: 42,
        inputTokens: 30,
        outputTokens: 12,
        costUsd: 0.003,
        modelName: "stub-model",
      }),
    });
    const tools = new handler.InMemoryToolRegistry();
    const llmCall: handler.LlmCallFn = async () => ({
      content: "",
      tokens: 0,
      costUsd: 0,
      model: "stub",
    });

    const app = createServer({ store });

    // 1. Web POSTs to enqueue a run.
    const enqueueRes = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowSha: "wf-sha",
        routing: { start_node: "start" },
      }),
    });
    expect(enqueueRes.status).toBe(200);
    const { runId } = (await enqueueRes.json()) as { runId: string };

    // 2. Daemon claims + executes.
    const claimed = store.claimNextRun(1);
    expect(claimed?.runId).toBe(runId);
    const ac = new AbortController();
    await runOne(runId, {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools,
      llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac.signal,
    });

    // 3. UI hits GET /runs/:id — sees success with adapter-derived shape.
    const detailRes = await app.request(`/runs/${runId}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      runId: string;
      status: string;
      costUsd: number;
      inputTokens: number;
      workflowName?: string;
      nodes: { nodeId: string; state: string }[];
      workflowSource?: string;
    };
    expect(detail.runId).toBe(runId);
    expect(detail.status).toBe("success");
    expect(detail.costUsd).toBeCloseTo(0.003, 6);
    expect(detail.inputTokens).toBe(30);
    expect(detail.workflowName).toBe("echo-wf");
    expect(detail.workflowSource).toBe("digraph Echo { start -> __end__ }");
    expect(detail.nodes.some((n) => n.nodeId === "start" && n.state === "completed")).toBe(true);

    // 4. Metrics dashboard reflects the run.
    const metricsRes = await app.request("/metrics/global");
    const metrics = (await metricsRes.json()) as {
      total_runs: number;
      billed_tokens: number;
      breakdownByModel: { model_name: string; tokens: number }[];
    };
    expect(metrics.total_runs).toBe(1);
    expect(metrics.billed_tokens).toBe(42);
    expect(metrics.breakdownByModel.find((m) => m.model_name === "stub-model")?.tokens).toBe(42);

    store.close();
  });

  test("HITL loop: pause at wait.human, reopen store, finish via intent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarm-e2e-hitl-"));
    const dbPath = join(dir, "swarm.db");

    // Phase 1 ─────────────────────────────────────────────────
    const s1 = new SqliteStore({ path: dbPath });
    s1.saveWorkflow("wf-sha", "hitl-wf", "digraph { ask -> __end__ }");
    const dispatcher = new Dispatcher();
    dispatcher.register(
      "wf-sha",
      "ask",
      handler.makeWaitHumanHandler({ options: [{ key: "A", label: "[A] Approve", to: "__end__" }] }),
    );
    const tools = new handler.InMemoryToolRegistry();
    const llmCall: handler.LlmCallFn = async () => ({
      content: "",
      tokens: 0,
      costUsd: 0,
      model: "stub",
    });

    const app1 = createServer({ store: s1 });
    const enqueueRes = await app1.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowSha: "wf-sha",
        routing: { start_node: "ask" },
      }),
    });
    const { runId } = (await enqueueRes.json()) as { runId: string };

    s1.claimNextRun(1);
    const ac1 = new AbortController();
    await runOne(runId, {
      store: s1,
      dispatcher,
      registry: new AbortRegistry(),
      tools,
      llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac1.signal,
    });
    expect(s1.getState(runId)!.status).toBe("paused_hitl");

    // Operator writes HITL input via HTTP.
    const hitlRes = await app1.request(`/runs/${runId}/hitl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selected: "A" }),
    });
    expect(hitlRes.status).toBe(200);
    s1.close();

    // Phase 2 — simulate daemon restart on a fresh store instance ─────
    const s2 = new SqliteStore({ path: dbPath });
    expect(s2.getState(runId)!.status).toBe("paused_hitl");
    // Re-register the dispatcher (in-memory state doesn't survive).
    const dispatcher2 = new Dispatcher();
    dispatcher2.register(
      "wf-sha",
      "ask",
      handler.makeWaitHumanHandler({ options: [{ key: "A", label: "[A] Approve", to: "__end__" }] }),
    );

    wakePending(s2);
    s2.claimNextRun(1);
    const ac2 = new AbortController();
    await runOne(runId, {
      store: s2,
      dispatcher: dispatcher2,
      registry: new AbortRegistry(),
      tools,
      llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: ac2.signal,
    });

    const app2 = createServer({ store: s2 });
    const finalRes = await app2.request(`/runs/${runId}`);
    const finalDetail = (await finalRes.json()) as { status: string };
    expect(finalDetail.status).toBe("success");
    s2.close();
  });
});
