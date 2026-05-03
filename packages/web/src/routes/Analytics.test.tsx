import { afterEach, describe, expect, test } from "bun:test";
import { getAnalytics, getAnalyticsRuns } from "../lib/api.ts";

// The user-visible contract for the project filter is "the chosen cwd
// reaches the server". Asserting that on the page-level component
// requires opening the Radix Select listbox, which happy-dom cannot
// render. The wire-side contract is testable directly: the api
// helpers translate `req.cwd` into the `?cwd=` query param. Page-level
// integration falls under e2e once that's in place.

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Analytics page · project filter", () => {
  test("threads the chosen cwd into the analytics summary fetch", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          window: { fromMs: 0, toMs: 1, bucket: "hour", tzOffsetMinutes: 0 },
          totals: {
            current: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            previous: null,
          },
          runsByBucket: [],
          spendByBucket: [],
          tokensByBucket: [],
          cacheByBucket: [],
          haltDistribution: [],
          modelDistribution: [],
          topWorkflows: [],
          compareWindow: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await getAnalytics({
      fromMs: 100,
      toMs: 200,
      bucket: "hour",
      tzOffsetMinutes: 0,
      cwd: "/abs/path",
    });

    expect(capturedUrl).toContain("from=100");
    expect(capturedUrl).toContain("to=200");
    expect(capturedUrl).toContain("cwd=%2Fabs%2Fpath");
  });

  test("omits the cwd param when no project is selected", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(
        JSON.stringify({
          window: { fromMs: 0, toMs: 1, bucket: "hour", tzOffsetMinutes: 0 },
          totals: {
            current: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            previous: null,
          },
          runsByBucket: [],
          spendByBucket: [],
          tokensByBucket: [],
          cacheByBucket: [],
          haltDistribution: [],
          modelDistribution: [],
          topWorkflows: [],
          compareWindow: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await getAnalytics({ fromMs: 100, toMs: 200, bucket: "hour", tzOffsetMinutes: 0 });

    expect(capturedUrl).not.toContain("cwd=");
  });

  test("threads cwd into the drill-down (analytics/runs) fetch", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ runs: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await getAnalyticsRuns({ fromMs: 100, toMs: 200, cwd: "/abs/path" });
    expect(capturedUrl).toContain("cwd=%2Fabs%2Fpath");
  });
});
