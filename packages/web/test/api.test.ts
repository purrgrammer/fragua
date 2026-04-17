// Unit tests for the fetch client. We exercise URL shape, ok parsing, and
// the two failure branches (HTTP status, malformed body). Routing through
// an injected `fetch` keeps the test pure — no network, no globals.

import { describe, expect, it } from "bun:test";
import { createApiClient } from "../src/lib/api.ts";

function mockFetch(response: Response, capture?: { url?: string }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    if (capture) capture.url = typeof input === "string" ? input : input.toString();
    return response;
  }) as typeof fetch;
}

describe("createApiClient", () => {
  it("GETs `${baseUrl}/health` and returns the parsed body", async () => {
    const captured: { url?: string } = {};
    const client = createApiClient({
      fetchImpl: mockFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }), captured),
    });
    const res = await client.health();
    expect(res).toEqual({ ok: true });
    expect(captured.url).toBe("/api/health");
  });

  it("honours baseUrl override", async () => {
    const captured: { url?: string } = {};
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
