// Unit tests for the fetch client + URL helpers.
//
// The client is plain exported functions; tests install a URL-routing
// fake `fetch` via the shared helper and assert on:
//   - URL shape (every call hits `/api/...`)
//   - ok parsing / validation
//   - Generic failure branches (HTTP status, malformed body)
//   - URL helpers are relative and /api-prefixed (the single enforcement
//     point for "no absolute URLs in the client" — absolute URLs would
//     land on Vite's dev server at 5173 instead of the fragua server).

import { afterEach, describe, expect, it } from "vitest";
import * as api from "../src/lib/api.ts";
import { installFetchMock, json } from "./helpers/with-query-client.tsx";

let mock: ReturnType<typeof installFetchMock> | undefined;

function mockResponse(url: string, response: Response): ReturnType<typeof installFetchMock> {
  return installFetchMock({ [url]: () => response });
}

afterEach(() => {
  mock?.restore();
  mock = undefined;
});

describe("api — /health", () => {
  it("GETs /api/health and returns the parsed body", async () => {
    mock = installFetchMock({ "/api/health": () => json({ ok: true }) });
    const res = await api.health();
    expect(res).toEqual({ ok: true });
    expect(mock.calls[0]?.url).toBe("/api/health");
  });

  it("throws on non-2xx HTTP status", async () => {
    mock = mockResponse("/api/health", new Response("oops", { status: 500, statusText: "Internal Server Error" }));
    await expect(api.health()).rejects.toThrow(/500/);
  });

  it("throws on malformed JSON body", async () => {
    mock = mockResponse("/api/health", json({ nope: 1 }));
    await expect(api.health()).rejects.toThrow(/malformed/);
  });
});

describe("api — /runs", () => {
  it("listRuns GETs /api/runs and parses the array", async () => {
    const rows = [
      { runId: "r1", startedAt: "2024-01-01T00:00:00Z", status: "success", eventCount: 3 },
      { runId: "r2", startedAt: "2024-01-02T00:00:00Z", status: "running", eventCount: 1 },
    ];
    mock = installFetchMock({ "/api/runs": () => json(rows) });
    const out = await api.listRuns();
    expect(mock.calls[0]?.url).toBe("/api/runs");
    expect(out).toHaveLength(2);
    expect(out[0]?.runId).toBe("r1");
  });

  it("getRun encodes the id and GETs /api/runs/:id", async () => {
    const body = {
      runId: "abc/weird",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 5,
      nodes: [],
      selectedEdges: [],
    };
    mock = installFetchMock({ "/api/runs/abc%2Fweird": () => json(body) });
    const res = await api.getRun("abc/weird");
    expect(mock.calls[0]?.url).toBe("/api/runs/abc%2Fweird");
    expect(res.runId).toBe("abc/weird");
  });

  it("getRun surfaces workflowSource (raw YAML) and the served fanout records when present", async () => {
    const source = "name: t\nsteps:\n  work: {type: llm, prompt: x}\n";
    const fanout = {
      parentOf: { lens_a: "review" },
      branchOf: { lens_a: "lens_a" },
      orderOf: { lens_a: 0 },
      nodeTypes: { review: "parallel", lens_a: "llm" },
    };
    mock = installFetchMock({
      "/api/runs/r1": () =>
        json({
          runId: "r1",
          startedAt: "2024-01-01T00:00:00Z",
          status: "running",
          lastEventSeq: 2,
          nodes: [],
          selectedEdges: [],
          workflowSource: source,
          fanout,
        }),
    });
    const res = await api.getRun("r1");
    expect(res.workflowSource).toBe(source);
    expect(res.fanout).toEqual(fanout);
  });

  it("getRun accepts a response that omits workflowSource (older servers)", async () => {
    mock = installFetchMock({
      "/api/runs/r1": () =>
        json({
          runId: "r1",
          startedAt: "2024-01-01T00:00:00Z",
          status: "unknown",
          lastEventSeq: 0,
          nodes: [],
          selectedEdges: [],
        }),
    });
    const res = await api.getRun("r1");
    expect(res.workflowSource).toBeUndefined();
  });

  it("listRuns rejects with ApiError on 5xx", async () => {
    mock = mockResponse("/api/runs", new Response("boom", { status: 503, statusText: "Service Unavailable" }));
    try {
      await api.listRuns();
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(api.ApiError);
      expect((err as api.ApiError).status).toBe(503);
      expect((err as api.ApiError).url).toBe("/api/runs");
    }
  });
});

describe("api — /workflows", () => {
  it("listWorkflows GETs /api/workflows and parses name/path/sha rows", async () => {
    const rows = [
      { name: "alpha", path: "workflows/alpha.yaml", sha: "abc1234", label: "Alpha" },
      { name: "beta", path: "workflows/beta.yaml", sha: "def5678" },
    ];
    mock = installFetchMock({ "/api/workflows": () => json(rows) });
    const out = await api.listWorkflows();
    expect(mock.calls[0]?.url).toBe("/api/workflows");
    expect(out).toHaveLength(2);
    expect(out[0]?.label).toBe("Alpha");
    expect(out[1]?.label).toBeUndefined();
  });

  it("rejects malformed workflow rows", async () => {
    mock = installFetchMock({ "/api/workflows": () => json([{ name: "x", path: "x.yaml" }]) });
    await expect(api.listWorkflows()).rejects.toThrow(/malformed/);
  });
});

describe("api — URL helpers are relative and /api-prefixed", () => {
  it("getRunEventsUrl returns a relative /api/runs/:id/stream (SSE endpoint)", () => {
    // Must point at /stream (text/event-stream) not /events (application/json).
    // Hitting /events with EventSource gives a MIME mismatch and the browser
    // aborts the connection without surfacing useful errors in useRunLive.
    const u = api.getRunEventsUrl("abc");
    expect(u).toBe("/api/runs/abc/stream");
    expect(u.startsWith("/api/")).toBe(true);
    expect(u).not.toMatch(/^https?:/);
    expect(u).not.toContain("localhost");
  });

  it("URL helpers encode unsafe id chars", () => {
    expect(api.getRunEventsUrl("a/b c")).toBe("/api/runs/a%2Fb%20c/stream");
  });
});

describe("api — control channel", () => {
  it("steerRun POSTs to /runs/:id/steer with a message body and returns { seq }", async () => {
    const calls: Array<{ body?: string }> = [];
    mock = installFetchMock({
      "/api/runs/run-7/steer": ({ init }) => {
        calls.push({ body: init?.body as string });
        return json({ seq: 42 });
      },
    });
    const res = await api.steerRun("run-7", "focus on tests");
    expect(res).toEqual({ seq: 42 });
    expect(mock.calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ text: "focus on tests" });
  });

  it("pauseRun omits body when reason is undefined", async () => {
    const bodies: Array<string | undefined> = [];
    mock = installFetchMock({
      "/api/runs/run-7/pause": ({ init }) => {
        bodies.push(init?.body as string | undefined);
        return json({ seq: 11 });
      },
    });
    await api.pauseRun("run-7");
    expect(mock.calls[0]?.method).toBe("POST");
    expect(bodies[0]).toBeUndefined();
  });

  it("pauseRun includes reason when provided", async () => {
    const bodies: string[] = [];
    mock = installFetchMock({
      "/api/runs/run-7/pause": ({ init }) => {
        bodies.push(init?.body as string);
        return json({ seq: 12 });
      },
    });
    await api.pauseRun("run-7", "stepping out");
    expect(JSON.parse(bodies[0] ?? "")).toEqual({ reason: "stepping out" });
  });

  it("resumeRun POSTs with no body", async () => {
    const bodies: Array<string | undefined> = [];
    mock = installFetchMock({
      "/api/runs/run-7/resume": ({ init }) => {
        bodies.push(init?.body as string | undefined);
        return json({ seq: 13 });
      },
    });
    await api.resumeRun("run-7");
    expect(mock.calls[0]?.url).toBe("/api/runs/run-7/resume");
    expect(bodies[0]).toBeUndefined();
  });

  it("cancelRun propagates reason and url-encodes the id", async () => {
    const bodies: string[] = [];
    mock = installFetchMock({
      "/api/runs/a%2Fb%20c/cancel": ({ init }) => {
        bodies.push(init?.body as string);
        return json({ seq: 14 });
      },
    });
    await api.cancelRun("a/b c", "wrong branch");
    expect(mock.calls[0]?.url).toBe("/api/runs/a%2Fb%20c/cancel");
    expect(JSON.parse(bodies[0] ?? "")).toEqual({ reason: "wrong branch" });
  });

  it("non-2xx responses throw ApiError with the status", async () => {
    mock = mockResponse(
      "/api/runs/ghost/steer",
      new Response(JSON.stringify({ error: "run not found" }), { status: 404 }),
    );
    try {
      await api.steerRun("ghost", "hi");
      throw new Error("expected ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(api.ApiError);
      expect((err as api.ApiError).status).toBe(404);
    }
  });
});
