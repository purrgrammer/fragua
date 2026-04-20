// Integration tests for the store-backed HTTP routes.
//
// Covers:
//   - All seven intent-write endpoints land an event on the store
//   - GET /runs/:id/events supports sinceSeq filtering
//   - GET /metrics/global aggregates via generated columns + json_each pivot
//   - P19: SSE replay via Last-Event-ID

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { createRoutes } from "../../src/store/routes.ts";

let store: SqliteStore;
let server: { fetch: (req: Request) => Response | Promise<Response> };

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf", "t", "digraph {}");
  server = createRoutes({ store });
});

afterEach(() => {
  store.close();
});

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return server.fetch(new Request(`http://test${path}`, init));
}

describe("POST /workflows — upload", () => {
  test("accepts DOT source, returns sha, persists via saveWorkflow", async () => {
    const res = await req("POST", "/workflows", {
      name: "hello",
      dotSource: "digraph Hello { a -> b }",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha: string; name: string };
    expect(body.name).toBe("hello");
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getWorkflow(body.sha)?.name).toBe("hello");
  });

  test("rejects missing fields", async () => {
    const res1 = await req("POST", "/workflows", { name: "x" });
    expect(res1.status).toBe(400);
    const res2 = await req("POST", "/workflows", { dotSource: "digraph{}" });
    expect(res2.status).toBe(400);
  });

  test("idempotent on same source — same sha, no duplicate row", async () => {
    const src = "digraph X { a -> b }";
    const a = (await (await req("POST", "/workflows", { name: "x", dotSource: src })).json()) as { sha: string };
    const b = (await (await req("POST", "/workflows", { name: "x", dotSource: src })).json()) as { sha: string };
    expect(a.sha).toBe(b.sha);
  });
});

describe("POST /runs — enqueue", () => {
  test("enqueues a run and returns the generated id", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", priority: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-z]+$/);

    const state = store.getState(body.runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("queued");
    expect(state!.priority).toBe(3);
  });

  test("rejects when workflowSha is missing", async () => {
    const res = await req("POST", "/runs", {});
    expect(res.status).toBe(400);
  });

  test("rejects unknown workflow", async () => {
    const res = await req("POST", "/runs", { workflowSha: "nonexistent" });
    expect(res.status).toBe(400);
  });

  test("body.input lands on routing.input — the $ARGUMENTS bridge", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", input: "rename foo to bar" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.routing["input"]).toBe("rename foo to bar");
  });

  test("explicit routing.input wins over body.input", async () => {
    const res = await req("POST", "/runs", {
      workflowSha: "wf",
      input: "ignored",
      routing: { input: "explicit", start_node: "s" },
    });
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state!.routing["input"]).toBe("explicit");
    expect(state!.routing["start_node"]).toBe("s");
  });

  test("no input → no routing.input key", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf" });
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect("input" in state!.routing).toBe(false);
  });

  test("preflightProviders returning ok:false rejects with code=provider_unavailable", async () => {
    const { createRoutes: fresh } = await import("../../src/store/routes.ts");
    const s = new SqliteStore({ path: ":memory:" });
    s.saveWorkflow("wf", "t", "digraph {}");
    const app = fresh({
      store: s,
      preflightProviders: () => ({ ok: false, detail: "no keys set" }),
    });
    const res = await app.fetch(
      new Request("http://test/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowSha: "wf" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("provider_unavailable");
    expect(body.error).toBe("no keys set");
    s.close();
  });

  test("preflightProviders returning ok:true allows the enqueue through", async () => {
    const { createRoutes: fresh } = await import("../../src/store/routes.ts");
    const s = new SqliteStore({ path: ":memory:" });
    s.saveWorkflow("wf", "t", "digraph {}");
    const app = fresh({
      store: s,
      preflightProviders: () => ({ ok: true }),
    });
    const res = await app.fetch(
      new Request("http://test/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowSha: "wf" }),
      }),
    );
    expect(res.status).toBe(200);
    s.close();
  });

  test("no preflightProviders dep → no preflight, enqueue always considered", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf" });
    expect(res.status).toBe(200);
  });
});

describe("envProviderPreflight", () => {
  test("ok when at least one known provider env var is set", async () => {
    const { envProviderPreflight } = await import("../../src/store/routes.ts");
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    try {
      expect(envProviderPreflight()).toEqual({ ok: true });
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  test("fails with detail listing expected env keys when none are set", async () => {
    const { envProviderPreflight } = await import("../../src/store/routes.ts");
    const knownKeys = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];
    const saved: Record<string, string | undefined> = {};
    for (const k of knownKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const res = envProviderPreflight();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        for (const k of knownKeys) expect(res.detail).toContain(k);
      }
    } finally {
      for (const k of knownKeys) {
        const v = saved[k];
        if (v !== undefined) process.env[k] = v;
      }
    }
  });
});

describe("GET /runs/:id/steps", () => {
  test("unknown run → 404 with code=not_found", async () => {
    // Note: this test lives alongside the other /runs/ read tests which
    // mount `createRoutes()` (intent writes + SSE). The steps endpoint is
    // mounted by `storeRunsRoutes`; this test exercises it via a full
    // server wired through createServer(). See steps.test.ts for the
    // pure reducer coverage.
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    const res = await app.request("/runs/unknown/steps");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("known run with no llm.start events → 200 with empty array", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "steps-empty", workflowSha: "wf" });
    const res = await app.request("/runs/steps-empty/steps");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("observability llm.start / text_delta / done → 1 step with finalText + duration", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "steps-one", workflowSha: "wf" });
    store.appendObservabilityEvents("steps-one", [
      { type: "llm.start", payload: { nodeId: "n1", prompt: "hi", model: "stub" } },
      { type: "llm.text_delta", payload: { nodeId: "n1", delta: "pong" } },
      { type: "llm.done", payload: { nodeId: "n1", stop_reason: "end_turn" } },
    ]);
    const res = await app.request("/runs/steps-one/steps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ nodeId: string; finalText: string; stopReason?: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.nodeId).toBe("n1");
    expect(body[0]!.finalText).toBe("pong");
    expect(body[0]!.stopReason).toBe("end_turn");
  });
});

describe("intent-write routes", () => {
  test.each([
    ["steer", "/steer", { text: "go" }, "intent.steering_requested"],
    ["pause", "/pause", undefined, "intent.pause_requested"],
    ["cancel", "/cancel", { reason: "stop" }, "intent.cancel_requested"],
    ["hitl", "/hitl", { input: "approved" }, "intent.hitl_input"],
    ["unquarantine", "/unquarantine", { resolution: "retry", note: "try again" }, "intent.unquarantine"],
    ["priority", "/priority", { newPriority: 5 }, "intent.priority_adjusted"],
  ] as const)("POST /runs/:id/%s writes an %s intent", async (_label, path, body, type) => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", `/runs/r${path}`, body);
    expect(res.status).toBe(200);
    const events = store.getEvents("r");
    expect(events.some((e) => e.type === type)).toBe(true);
  });

  test("POST /runs/:id/steer rejects empty text", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", "/runs/r/steer", { text: "" });
    expect(res.status).toBe(400);
  });

  test("POST /runs/:id/unquarantine rejects bad resolution", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", "/runs/r/unquarantine", {
      resolution: "bogus",
    });
    expect(res.status).toBe(400);
  });
});

describe("reads", () => {
  test("GET /runs/:id/events supports since= filter", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    store.appendIntent("r", { type: "intent.pause_requested", payload: {} });
    store.appendIntent("r", {
      type: "intent.steering_requested",
      payload: { text: "hi" },
    });

    const all = (await (await req("GET", "/runs/r/events")).json()) as {
      seq: number;
    }[];
    const after1 = (await (await req("GET", "/runs/r/events?since=1")).json()) as { seq: number }[];
    expect(all).toHaveLength(3);
    expect(after1).toHaveLength(2);
    expect(after1[0]!.seq).toBeGreaterThan(1);
  });
});

describe("GET /metrics/global", () => {
  test("sums generated columns + pivots model breakdown", async () => {
    store.enqueueRun({ runId: "r1", workflowSha: "wf" });
    const s = store.getState("r1")!;
    store.appendFact(
      "r1",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: "wf",
            schemaVersion: s.schemaVersion,
            startNode: "a",
          },
        },
      ],
      s.version,
    );
    const s1 = store.getState("r1")!;
    store.appendFact(
      "r1",
      [
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "a",
            iteration: 0,
            tokens: 100,
            costUsd: 0.02,
            modelName: "gemini-1.5-pro",
            nextNode: "__end__",
          },
        },
        { type: "fact.run_completed", payload: { finalNode: "__end__" } },
      ],
      s1.version,
    );

    const res = await req("GET", "/metrics/global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_runs: number;
      total_usd: number;
      total_tokens: number;
      successful: number;
      breakdownByModel: { model_name: string; tokens: number; cost_usd: number }[];
    };
    expect(body.total_runs).toBe(1);
    expect(body.total_tokens).toBe(100);
    expect(body.total_usd).toBeCloseTo(0.02, 6);
    expect(body.successful).toBe(1);
    const pro = body.breakdownByModel.find((r) => r.model_name === "gemini-1.5-pro");
    expect(pro).toBeDefined();
    expect(pro!.tokens).toBe(100);
    expect(pro!.cost_usd).toBeCloseTo(0.02, 6);
  });
});

describe("P19 — SSE replay via Last-Event-ID", () => {
  test("reconnect with Last-Event-ID=N delivers only events with seq > N", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    // Produce three intents so the stream has seq 1..4 (incl the enqueue intent).
    store.appendIntent("r", { type: "intent.pause_requested", payload: {} });
    store.appendIntent("r", {
      type: "intent.steering_requested",
      payload: { text: "go" },
    });
    store.appendIntent("r", {
      type: "intent.cancel_requested",
      payload: { reason: "stop" },
    });

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(
      new Request("http://test/runs/r/stream", {
        headers: { "Last-Event-ID": "2" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += decoder.decode(value, { stream: true });
      if (chunks.includes("id: 4")) break;
    }
    await reader.cancel();

    // Stream must contain seq 3 and 4, and NOT seq 1 or 2.
    expect(chunks).toContain("id: 3");
    expect(chunks).toContain("id: 4");
    expect(chunks).not.toContain("id: 1\n");
    expect(chunks).not.toContain("id: 2\n");
  });
});
