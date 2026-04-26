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

  test("rejects malformed timeout attr with 400 + invalid_timeout_attr code", async () => {
    const res = await req("POST", "/workflows", {
      name: "bad",
      dotSource: `digraph { start [shape=Mdiamond]; impl [shape=box, timeout="garbage"]; done [shape=Msquare]; start -> impl -> done; }`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string; offender: { nodeId: string; attr: string } };
    expect(body.code).toBe("invalid_timeout_attr");
    expect(body.offender.nodeId).toBe("impl");
    expect(body.offender.attr).toBe("timeout");
    expect(body.error).toMatch(/impl/);
    expect(body.error).toMatch(/garbage/);
  });

  test("rejects zero / negative maxMs", async () => {
    const res = await req("POST", "/workflows", {
      name: "bad",
      dotSource: `digraph { start [shape=Mdiamond]; a [shape=box, maxMs=0]; done [shape=Msquare]; start -> a -> done; }`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_timeout_attr");
  });

  test("accepts valid timeout strings", async () => {
    for (const t of ["500ms", "30s", "5m", "2h"]) {
      const res = await req("POST", "/workflows", {
        name: "ok",
        dotSource: `digraph { start [shape=Mdiamond]; a [shape=box, timeout="${t}"]; done [shape=Msquare]; start -> a -> done; }`,
      });
      expect(res.status).toBe(200);
    }
  });

  test("accepts valid numeric maxMs", async () => {
    const res = await req("POST", "/workflows", {
      name: "ok",
      dotSource: `digraph { start [shape=Mdiamond]; a [shape=box, maxMs=1500]; done [shape=Msquare]; start -> a -> done; }`,
    });
    expect(res.status).toBe(200);
  });

  test("validator rejects a workflow with unresolved model IDs", async () => {
    // Inject a stub validator — mirrors the daemon wiring. Production
    // uses @swarm/agent's validateWorkflowModels, but @swarm/server
    // stays pi-ai-free.
    const localStore = new SqliteStore({ path: ":memory:" });
    const local = createRoutes({
      store: localStore,
      validateWorkflowModels: (dotSource) => {
        if (dotSource.includes("claude-sonnet-4-6")) {
          return {
            ok: false as const,
            offenders: [
              {
                nodeId: "impl",
                provider: "openrouter",
                model: "claude-sonnet-4-6",
                reason: "unknown model",
              },
            ],
          };
        }
        return { ok: true as const };
      },
    });

    const badRes = await local.fetch(
      new Request("http://test/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "bad",
          dotSource: `digraph { impl [shape=box, model="claude-sonnet-4-6", provider="openrouter"]; }`,
        }),
      }),
    );
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as {
      code: string;
      offenders: Array<{ nodeId: string; model: string }>;
    };
    expect(badBody.code).toBe("model_unresolved");
    expect(badBody.offenders).toHaveLength(1);
    expect(badBody.offenders[0]?.nodeId).toBe("impl");
    expect(badBody.offenders[0]?.model).toBe("claude-sonnet-4-6");

    // The good path still accepts.
    const goodRes = await local.fetch(
      new Request("http://test/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "good", dotSource: "digraph { a -> b }" }),
      }),
    );
    expect(goodRes.status).toBe(200);

    localStore.close();
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

  test("queue-full backpressure: 429 with Retry-After when maxQueuedRuns is met", async () => {
    // Build a fresh server with a small cap so we can drive it past.
    const capped = createRoutes({ store, maxQueuedRuns: 2 });
    const cReq = (method: string, path: string, body?: unknown): Promise<Response> => {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      return Promise.resolve(capped.fetch(new Request(`http://test${path}`, init)));
    };

    // Two enqueues fit; the third trips the cap.
    expect((await cReq("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await cReq("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    const overflow = await cReq("POST", "/runs", { workflowSha: "wf" });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("Retry-After")).toBe("30");
    const body = (await overflow.json()) as { error: string; code: string };
    expect(body.code).toBe("queue_full");
    expect(body.error).toMatch(/queue full/i);
  });

  test("uncapped server (default) accepts past any threshold", async () => {
    // baseline: same shape as the queue-full test, but without the cap.
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
  });

  test("oversized intent payload → 413 with code=payload_too_large (not 500)", async () => {
    // Steer with text that, once JSON-wrapped, exceeds MAX_EVENT_PAYLOAD_BYTES (4 KB).
    // 5000 bytes of "x" plus the wrapper comfortably blows past the cap.
    store.enqueueRun({ runId: "rbig", workflowSha: "wf" });
    const res = await req("POST", "/runs/rbig/steer", { text: "x".repeat(5000) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; sizeBytes: number; maxBytes: number };
    expect(body.code).toBe("payload_too_large");
    expect(body.sizeBytes).toBeGreaterThan(body.maxBytes);
    expect(body.maxBytes).toBe(4096);
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

  test("step duration anchors to fact.node_* timestamps, not buffered llm.start", async () => {
    // pi-agent-core flushes llm.start at the end of the call, so its
    // ts is unreliable for wall-clock duration. The reducer anchors
    // each step's `startedAt` to `fact.node_started.ts` (truthful) and
    // its `durationMs` to the next step's startedAt OR — for the last
    // step on a terminal run — the run's last event ts.
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "steps-one", workflowSha: "wf" });
    const s0 = store.getState("steps-one")!;
    store.appendFact(
      "steps-one",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: s0.schemaVersion, startNode: "n1" } }],
      s0.version,
    );
    const s1 = store.getState("steps-one")!;
    store.appendFact("steps-one", [{ type: "fact.node_started", payload: { nodeId: "n1", iteration: 0 } }], s1.version);
    store.appendObservabilityEvents("steps-one", [{ type: "llm.start", payload: { nodeId: "n1", model: "stub" } }]);
    const s2 = store.getState("steps-one")!;
    store.appendFact("steps-one", [{ type: "fact.run_completed", payload: { finalNode: "n1" } }], s2.version);

    const res = await app.request("/runs/steps-one/steps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ nodeId: string; model?: string; durationMs?: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.nodeId).toBe("n1");
    expect(body[0]!.model).toBe("stub");
    // Last step on a terminal run gets a durationMs from the run's
    // last event ts.
    expect(typeof body[0]!.durationMs).toBe("number");
    expect(body[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /runs/:id/messages", () => {
  test("unknown run → 404 with code=not_found", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    const res = await app.request("/runs/missing/messages");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("returns appended messages as AgentMessage JSON", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "msgs-one", workflowSha: "wf" });
    store.appendMessage("msgs-one", {
      content: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      nodeId: "n1",
      iteration: 0,
    });
    const res = await app.request("/runs/msgs-one/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      content: { role: string; content: Array<{ type: string; text: string }> };
      nodeId: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.content.role).toBe("user");
    expect(body[0]!.content.content[0]).toMatchObject({ type: "text", text: "hello" });
  });

  test("filters by nodeId + sinceOrdinal", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "msgs-filter", workflowSha: "wf" });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
      nodeId: "a",
      iteration: 0,
    });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
      nodeId: "a",
      iteration: 0,
    });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "three" }], timestamp: 3 },
      nodeId: "b",
      iteration: 0,
    });

    const byNodeRes = await app.request("/runs/msgs-filter/messages?nodeId=a");
    const byNode = (await byNodeRes.json()) as Array<{ content: { content: Array<{ text: string }> } }>;
    expect(byNode.map((m) => m.content.content[0]?.text)).toEqual(["one", "two"]);

    const sinceRes = await app.request("/runs/msgs-filter/messages?sinceOrdinal=1");
    const sinceOne = (await sinceRes.json()) as Array<{ ordinal: number }>;
    expect(sinceOne.map((m) => m.ordinal)).toEqual([2, 3]);
  });
});

describe("intent-write routes", () => {
  test.each([
    ["steer", "/steer", { text: "go" }, "intent.steering_requested"],
    ["pause", "/pause", undefined, "intent.pause_requested"],
    ["cancel", "/cancel", { reason: "stop" }, "intent.cancel_requested"],
    ["hitl", "/hitl", { input: "approved" }, "intent.hitl_input"],
    ["resume", "/resume", { note: "topped up" }, "intent.resume"],
    ["resume-noargs", "/resume", undefined, "intent.resume"],
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

  test("/runs/:id/stream drains all events before closing on a terminal run", async () => {
    // Regression: the loop used to check terminal *after every batch*,
    // so a completed run with > batchSize events sent only the first
    // batch and returned, dropping everything past it. Browser opening
    // the conversation page on a terminal run would then see liveCost
    // / message buffers with chunks missing.
    store.enqueueRun({ runId: "long", workflowSha: "wf" });
    const s0 = store.getState("long")!;
    store.appendFact(
      "long",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: s0.schemaVersion, startNode: "a" } }],
      s0.version,
    );
    // Emit 12 cost.recorded events, well past a tiny batchSize of 3.
    // We use a non-fact event type so we don't perturb projection state.
    const obs = Array.from({ length: 12 }, () => ({
      type: "cost.recorded" as const,
      payload: { cost_usd: 0.001, total_tokens: 10, nodeId: "a" } as Record<string, unknown>,
    }));
    store.appendObservabilityEvents("long", obs);
    const s1 = store.getState("long")!;
    store.appendFact("long", [{ type: "fact.run_completed", payload: { finalNode: "a" } }], s1.version);

    const routes = createRoutes({ store, ssePollMs: 10, sseBatchSize: 3 });
    const res = await routes.fetch(new Request("http://test/runs/long/stream"));
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    let closed = false;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      chunks += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    // Stream closed cleanly (terminal exit path fired).
    expect(closed).toBe(true);
    // All 12 cost.recorded events delivered, not just the first batchSize=3.
    const costMatches = chunks.match(/"type":"cost\.recorded"/g) ?? [];
    expect(costMatches.length).toBe(12);
    // Terminal fact made it through too.
    expect(chunks).toContain("fact.run_completed");
  });

  test("/runs/:id/stream closes on its own once the run reaches a terminal status", async () => {
    // Without this close, the loop would poll forever after the run
    // ended, and the browser's EventSource would auto-reconnect on every
    // proxy/idle drop. The handler must return after the last batch
    // that includes a terminal fact.
    store.enqueueRun({ runId: "term", workflowSha: "wf" });
    const s0 = store.getState("term")!;
    store.appendFact(
      "term",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: s0.schemaVersion, startNode: "a" } }],
      s0.version,
    );
    const s1 = store.getState("term")!;
    store.appendFact("term", [{ type: "fact.run_completed", payload: { finalNode: "a" } }], s1.version);

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(new Request("http://test/runs/term/stream"));
    expect(res.status).toBe(200);

    // Drain the response — if the close fires correctly, `reader.read()`
    // resolves with `done: true` quickly. If it doesn't, the test times
    // out at the deadline (which would also fail the assertion below).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    let closed = false;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      chunks += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    expect(closed).toBe(true);
    expect(chunks).toContain("fact.run_completed");
  });
});
