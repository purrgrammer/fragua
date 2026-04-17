// Unit tests for the fetch client + URL helpers. We exercise:
//   - URL shape (every call hits `${baseUrl}${path}`)
//   - `ok` parsing / validation
//   - The two generic failure branches (HTTP status, malformed body)
//   - The Accept header on the SVG fetch
//   - URL helpers are RELATIVE and always `/api`-prefixed — this is the
//     single enforcement point for "no absolute URLs in the client", which
//     matters because absolute URLs would land on Vite's dev server (5173)
//     instead of the swarm server (3000).

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

describe("createApiClient — /pipelines/:id/graph.svg", () => {
  it("GETs /api/pipelines/:id/graph.svg with Accept: image/svg+xml and returns the SVG text", async () => {
    const captured: Captured = {};
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(svg, { status: 200, headers: { "content-type": "image/svg+xml" } }), captured),
    });
    const out = await client.getPipelineGraph("abc");
    expect(captured.url).toBe("/api/pipelines/abc/graph.svg");
    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect(headers["Accept"]).toBe("image/svg+xml");
    expect(out).toContain("<svg");
  });

  it("rejects with ApiError when the server 404s", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response("no such run", { status: 404, statusText: "Not Found" })),
    });
    try {
      await client.getPipelineGraph("missing");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });

  it("rejects when response is not an SVG document", async () => {
    const client = createApiClient({
      fetchImpl: mockFetch(new Response("<html>nope</html>", { status: 200 })),
    });
    await expect(client.getPipelineGraph("abc")).rejects.toThrow(/not an SVG/);
  });
});

describe("createApiClient — URL helpers are relative and /api-prefixed", () => {
  // The whole point: any URL the client hands out must resolve against
  // the page origin AND get intercepted by Vite's /api proxy. Absolute
  // URLs (http://..., window.location.origin + ...) would land on the
  // dev server (5173) instead of the swarm server (3000).

  const client = createApiClient();

  it("getPipelineGraphUrl returns a relative /api/pipelines/:id/graph.svg", () => {
    const u = client.getPipelineGraphUrl("abc");
    expect(u).toBe("/api/pipelines/abc/graph.svg");
    expect(u.startsWith("/api/")).toBe(true);
    expect(u).not.toMatch(/^https?:/);
    expect(u).not.toContain("localhost");
    expect(u).not.toContain("://");
  });

  it("getPipelineEventsUrl returns a relative /api/pipelines/:id/events", () => {
    const u = client.getPipelineEventsUrl("abc");
    expect(u).toBe("/api/pipelines/abc/events");
    expect(u.startsWith("/api/")).toBe(true);
    expect(u).not.toMatch(/^https?:/);
    expect(u).not.toContain("localhost");
  });

  it("URL helpers encode unsafe id chars", () => {
    expect(client.getPipelineGraphUrl("a/b c")).toBe("/api/pipelines/a%2Fb%20c/graph.svg");
    expect(client.getPipelineEventsUrl("a/b c")).toBe("/api/pipelines/a%2Fb%20c/events");
  });

  it("pipelineEventsUrl alias matches getPipelineEventsUrl", () => {
    expect(client.pipelineEventsUrl("x")).toBe(client.getPipelineEventsUrl("x"));
  });

  it("baseUrl property is exposed and consistent with URL helpers", () => {
    expect(client.baseUrl).toBe("/api");
    const custom = createApiClient({ baseUrl: "/custom" });
    expect(custom.baseUrl).toBe("/custom");
    expect(custom.getPipelineGraphUrl("z")).toBe("/custom/pipelines/z/graph.svg");
  });
});
