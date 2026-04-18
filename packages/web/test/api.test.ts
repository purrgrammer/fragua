// Unit tests for the fetch client + URL helpers. We exercise:
//   - URL shape (every call hits `${baseUrl}${path}`)
//   - `ok` parsing / validation
//   - The two generic failure branches (HTTP status, malformed body)
//   - URL helpers are RELATIVE and always `/api`-prefixed — this is the
//     single enforcement point for "no absolute URLs in the client", which
//     matters because absolute URLs would land on Vite's dev server (5173)
//     instead of the swarm server (3000).
//   - GET /pipelines/:id surfaces `workflowSource` (the raw DOT string).
//     There is NO `edges` field on PipelineDetail — topology is parsed
//     client-side via @swarm/core's parseDotSource (see GraphView.tsx).
//   - GET /workflows returns the listWorkflows() array.

import { describe, expect, it } from "bun:test";
import { ApiError, createApiClient } from "../src/lib/api.ts";

interface Captured {
  url?: string;
  init?: RequestInit;
}

function mockFetch(response: Response | (() => Response), capture?: Captured): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = typeof input === "string" ? input : input.toString();
      if (init) capture.init = init;
    }
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
}

describe("createApiClient — /health", () => {
  it("GETs `${baseUrl}/health` and returns the parsed body", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }), captured),
    });
    const res = await client.health();
    expect(res).toEqual({ ok: true });
    expect(captured.url).toBe("/api/health");
  });

  it("honours baseUrl override", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      baseUrl: "http://example.test",
      fetchImpl: mockFetch(new Response(JSON.stringify({ ok: true })), captured),
    });
    await client.health();
    expect(captured.url).toBe("http://example.test/health");
  });

  it("throws on non-2xx HTTP status", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response("oops", { status: 500, statusText: "Internal Server Error" })),
    });
    await expect(client.health()).rejects.toThrow(/500/);
  });

  it("throws on malformed JSON body", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ nope: 1 }), { status: 200 })),
    });
    await expect(client.health()).rejects.toThrow(/malformed/);
  });
});

describe("createApiClient — /pipelines", () => {
  it("listPipelines GETs /api/pipelines and parses the array", async () => {
    const captured: Captured = {};
    const rows = [
      { runId: "r1", startedAt: "2024-01-01T00:00:00Z", status: "success", eventCount: 3 },
      { runId: "r2", startedAt: "2024-01-02T00:00:00Z", status: "running", eventCount: 1 },
    ];
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify(rows), { status: 200 }), captured),
    });
    const out = await client.listPipelines();
    expect(captured.url).toBe("/api/pipelines");
    expect(out).toHaveLength(2);
    expect(out[0]?.runId).toBe("r1");
  });

  it("getPipeline encodes the id and GETs /api/pipelines/:id", async () => {
    const captured: Captured = {};
    const body = {
      runId: "abc/weird",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 5,
      nodes: [],
    };
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify(body), { status: 200 }), captured),
    });
    const res = await client.getPipeline("abc/weird");
    expect(captured.url).toBe("/api/pipelines/abc%2Fweird");
    expect(res.runId).toBe("abc/weird");
  });

  it("getPipeline surfaces workflowSource (raw DOT) when present", async () => {
    const source = "digraph g { a -> b }";
    const body = {
      runId: "r1",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 2,
      nodes: [],
      workflowSource: source,
    };
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify(body), { status: 200 })),
    });
    const res = await client.getPipeline("r1");
    expect(res.workflowSource).toBe(source);
  });

  it("getPipeline accepts a response that omits workflowSource (older servers)", async () => {
    const body = {
      runId: "r1",
      startedAt: "2024-01-01T00:00:00Z",
      status: "unknown",
      lastEventSeq: 0,
      nodes: [],
    };
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify(body), { status: 200 })),
    });
    const res = await client.getPipeline("r1");
    expect(res.workflowSource).toBeUndefined();
  });

  it("listPipelines rejects with ApiError on 5xx", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response("boom", { status: 503, statusText: "Service Unavailable" })),
    });
    try {
      await client.listPipelines();
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(503);
      expect((err as ApiError).url).toBe("/api/pipelines");
    }
  });
});

describe("createApiClient — /workflows", () => {
  it("listWorkflows GETs /api/workflows and parses name/path/sha rows", async () => {
    const captured: Captured = {};
    const rows = [
      { name: "alpha", path: "workflows/alpha.dot", sha: "abc1234", label: "Alpha" },
      { name: "beta", path: "workflows/beta.dot", sha: "def5678" },
    ];
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify(rows), { status: 200 }), captured),
    });
    const out = await client.listWorkflows();
    expect(captured.url).toBe("/api/workflows");
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("Alpha");
    expect(out[1]?.label).toBeUndefined();
  });

  it("rejects malformed workflow rows", async () => {
    const client = createApiClient({
      // missing required `sha`
      fetchImpl: mockFetch(new Response(JSON.stringify([{ name: "x", path: "x.dot" }]), { status: 200 })),
    });
    await expect(client.listWorkflows()).rejects.toThrow(/malformed/);
  });
});

describe("createApiClient — URL helpers are relative and /api-prefixed", () => {
  // The whole point: any URL the client hands out must resolve against
  // the page origin AND get intercepted by Vite's /api proxy. Absolute
  // URLs (http://..., window.location.origin + ...) would land on the
  // dev server (5173) instead of the swarm server (3000).

  const client = createApiClient();

  it("getPipelineEventsUrl returns a relative /api/pipelines/:id/events", () => {
    const u = client.getPipelineEventsUrl("abc");
    expect(u).toBe("/api/pipelines/abc/events");
    expect(u.startsWith("/api/")).toBe(true);
    expect(u).not.toMatch(/^https?:/);
    expect(u).not.toContain("localhost");
  });

  it("URL helpers encode unsafe id chars", () => {
    expect(client.getPipelineEventsUrl("a/b c")).toBe("/api/pipelines/a%2Fb%20c/events");
  });

  it("pipelineEventsUrl alias matches getPipelineEventsUrl", () => {
    expect(client.pipelineEventsUrl("x")).toBe(client.getPipelineEventsUrl("x"));
  });

  it("baseUrl property is exposed and consistent with URL helpers", () => {
    expect(client.baseUrl).toBe("/api");
    const custom = createApiClient({ baseUrl: "/custom" });
    expect(custom.baseUrl).toBe("/custom");
    expect(custom.getPipelineEventsUrl("z")).toBe("/custom/pipelines/z/events");
  });
});

describe("createApiClient — control channel", () => {
  it("steerRun POSTs to /pipelines/:id/steer with a message body and returns { id }", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ id: "abc-123" }), { status: 202 }), captured),
    });
    const res = await client.steerRun("run-7", "focus on tests");
    expect(res).toEqual({ id: "abc-123" });
    expect(captured.url).toBe("/api/pipelines/run-7/steer");
    expect(captured.init?.method).toBe("POST");
    expect(JSON.parse(captured.init?.body as string)).toEqual({ message: "focus on tests" });
  });

  it("pauseRun omits body when reason is undefined", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ id: "p1" }), { status: 202 }), captured),
    });
    await client.pauseRun("run-7");
    expect(captured.url).toBe("/api/pipelines/run-7/pause");
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.body).toBeUndefined();
  });

  it("pauseRun includes reason when provided", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ id: "p2" }), { status: 202 }), captured),
    });
    await client.pauseRun("run-7", "stepping out");
    expect(JSON.parse(captured.init?.body as string)).toEqual({ reason: "stepping out" });
  });

  it("resumeRun POSTs with no body", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ id: "r1" }), { status: 202 }), captured),
    });
    await client.resumeRun("run-7");
    expect(captured.url).toBe("/api/pipelines/run-7/resume");
    expect(captured.init?.body).toBeUndefined();
  });

  it("cancelRun propagates reason and url-encodes the id", async () => {
    const captured: Captured = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ id: "c1" }), { status: 202 }), captured),
    });
    await client.cancelRun("a/b c", "wrong branch");
    expect(captured.url).toBe("/api/pipelines/a%2Fb%20c/cancel");
    expect(JSON.parse(captured.init?.body as string)).toEqual({ reason: "wrong branch" });
  });

  it("non-2xx responses throw ApiError with the status", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ error: "run not found" }), { status: 404 })),
    });
    try {
      await client.steerRun("ghost", "hi");
      throw new Error("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });
});
