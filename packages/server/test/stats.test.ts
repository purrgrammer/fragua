// GET /stats — server-side aggregate over every run under runsDir.
//
// Two flavors of assertion here:
//   1. Direct shape checks on the wire payload (totalRuns, successRate,
//      etc.) so a regression in the route is caught loudly.
//   2. A *parity* test that runs the same fixtures through the client-side
//      reducer (`@swarm/web`'s `lib/stats.ts` — copied here as a small
//      pure helper to avoid a cross-package test import) and asserts the
//      two agree on every shared field. Keeps the two implementations
//      from drifting silently.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { createServer } from "../src/index.ts";
import { StatsPayload } from "../src/schemas.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("GET /stats", () => {
  test("returns zero-valued payload for an empty runs dir", async () => {
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Value.Check(StatsPayload, body)).toBe(true);
    expect(body["totalRuns"]).toBe(0);
    expect(body["running"]).toBe(0);
    expect(body["succeeded"]).toBe(0);
    expect(body["failed"]).toBe(0);
    expect(body["canceled"]).toBe(0);
    expect(body["successRate"]).toBe(0);
    expect(body["totalCostUsd"]).toBe(0);
    expect(body["totalInputTokens"]).toBe(0);
    expect(body["totalOutputTokens"]).toBe(0);
    expect("avgDurationMs" in body).toBe(false);
    expect(typeof body["updatedAt"]).toBe("string");
  });

  test("aggregates counts, cost, tokens, and avg duration across mixed runs", async () => {
    const runs = {
      // success, 60s span, $0.10
      a: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
        ev({
          type: "cost.recorded",
          timestamp: "2024-01-01T00:00:30.000Z",
          data: { cost_usd: 0.1, input_tokens: 100, output_tokens: 50 },
        }),
        ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:01:00.000Z" }),
      ],
      // failure, 30s span, $0.05
      b: [
        ev({ type: "pipeline.started", timestamp: "2024-01-02T00:00:00.000Z" }),
        ev({
          type: "cost.recorded",
          timestamp: "2024-01-02T00:00:15.000Z",
          data: { cost_usd: 0.05, input_tokens: 200, output_tokens: 25 },
        }),
        ev({ type: "pipeline.failed", timestamp: "2024-01-02T00:00:30.000Z" }),
      ],
      // running — no terminal event, durationMs not counted
      c: [
        ev({ type: "pipeline.started", timestamp: "2024-01-03T00:00:00.000Z" }),
        ev({
          type: "cost.recorded",
          timestamp: "2024-01-03T00:00:10.000Z",
          data: { cost_usd: 0.02, input_tokens: 50, output_tokens: 10 },
        }),
      ],
      // canceled — counted in its own bucket, excluded from successRate
      // and avgDuration so user-initiated terminations don't distort either.
      d: [
        ev({ type: "pipeline.started", timestamp: "2024-01-04T00:00:00.000Z" }),
        ev({ type: "pipeline.canceled", timestamp: "2024-01-04T00:00:05.000Z" }),
      ],
    };

    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/stats");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body["totalRuns"]).toBe(4);
    expect(body["running"]).toBe(1);
    expect(body["succeeded"]).toBe(1);
    expect(body["failed"]).toBe(1);
    expect(body["canceled"]).toBe(1);
    // 1 success / (1 success + 1 fail) — canceled is not in the denominator.
    expect(body["successRate"]).toBeCloseTo(0.5, 6);
    expect(body["totalCostUsd"]).toBeCloseTo(0.17, 6);
    expect(body["totalInputTokens"]).toBe(350);
    expect(body["totalOutputTokens"]).toBe(85);
    // Avg only over a (60s) and b (30s) → 45s. Canceled d (5s) is excluded.
    expect(body["avgDurationMs"]).toBe(45_000);
  });

  test("?workflow filter narrows the aggregate to one workflow name", async () => {
    const runs = {
      a: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z", data: { workflow: "alpha.dot" } }),
        ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:10.000Z" }),
      ],
      b: [
        ev({ type: "pipeline.started", timestamp: "2024-01-02T00:00:00.000Z", data: { workflow: "beta.dot" } }),
        ev({ type: "pipeline.failed", timestamp: "2024-01-02T00:00:20.000Z" }),
      ],
    };
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/stats?workflow=alpha");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["totalRuns"]).toBe(1);
    expect(body["succeeded"]).toBe(1);
    expect(body["failed"]).toBe(0);
  });

  test("skips torn runs whose events cannot be read", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: {
        runReader: {
          async listRuns() {
            return ["good", "torn"];
          },
          async readEvents(id) {
            if (id === "torn") return undefined;
            return [
              ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
              ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:01.000Z" }),
            ];
          },
        },
      },
    });
    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["totalRuns"]).toBe(1);
    expect(body["succeeded"]).toBe(1);
  });

  test("parity: server payload matches a client-side reducer over the same input", async () => {
    // Mirrors the shape of `web/src/lib/stats.ts` — we re-implement here
    // (rather than cross-import) to keep the test free of a build-time
    // dep on @swarm/web.
    type Summary = {
      status: "running" | "success" | "fail" | "canceled" | "unknown";
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      durationMs?: number;
    };
    function clientStats(rows: Summary[]) {
      let running = 0;
      let succeeded = 0;
      let failed = 0;
      let canceled = 0;
      let totalCostUsd = 0;
      let totalTokens = 0;
      let durationSum = 0;
      let durationCount = 0;
      for (const r of rows) {
        if (r.status === "running") running += 1;
        else if (r.status === "success") succeeded += 1;
        else if (r.status === "fail") failed += 1;
        else if (r.status === "canceled") canceled += 1;
        totalCostUsd += r.costUsd;
        totalTokens += r.inputTokens + r.outputTokens;
        if ((r.status === "success" || r.status === "fail") && r.durationMs !== undefined) {
          durationSum += r.durationMs;
          durationCount += 1;
        }
      }
      const terminal = succeeded + failed;
      return {
        totalRuns: rows.length,
        running,
        succeeded,
        failed,
        canceled,
        successRate: terminal === 0 ? 0 : succeeded / terminal,
        totalCostUsd,
        totalTokens,
        ...(durationCount > 0 ? { avgDurationMs: durationSum / durationCount } : {}),
      };
    }

    const runs = {
      a: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" }),
        ev({
          type: "cost.recorded",
          timestamp: "2024-01-01T00:00:30.000Z",
          data: { cost_usd: 0.1, input_tokens: 100, output_tokens: 50 },
        }),
        ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:01:00.000Z" }),
      ],
      b: [
        ev({ type: "pipeline.started", timestamp: "2024-01-02T00:00:00.000Z" }),
        ev({ type: "pipeline.failed", timestamp: "2024-01-02T00:00:30.000Z" }),
      ],
      c: [
        ev({ type: "pipeline.started", timestamp: "2024-01-03T00:00:00.000Z" }),
        ev({ type: "pipeline.canceled", timestamp: "2024-01-03T00:00:10.000Z" }),
      ],
    };

    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const serverRes = (await (await app.request("/stats")).json()) as Record<string, unknown>;
    const listRes = (await (await app.request("/pipelines")).json()) as Summary[];
    const clientRes = clientStats(listRes);

    expect(serverRes["totalRuns"]).toBe(clientRes.totalRuns);
    expect(serverRes["running"]).toBe(clientRes.running);
    expect(serverRes["succeeded"]).toBe(clientRes.succeeded);
    expect(serverRes["failed"]).toBe(clientRes.failed);
    expect(serverRes["canceled"]).toBe(clientRes.canceled);
    expect(serverRes["successRate"]).toBeCloseTo(clientRes.successRate, 6);
    expect(serverRes["totalCostUsd"]).toBeCloseTo(clientRes.totalCostUsd, 6);
    expect((serverRes["totalInputTokens"] as number) + (serverRes["totalOutputTokens"] as number)).toBe(
      clientRes.totalTokens,
    );
    if (clientRes.avgDurationMs !== undefined) {
      expect(serverRes["avgDurationMs"]).toBe(clientRes.avgDurationMs);
    }
  });
});
