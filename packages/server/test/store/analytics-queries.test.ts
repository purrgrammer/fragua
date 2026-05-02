// Unit tests for the /analytics aggregation queries.
//
// Run against `:memory:` SqliteStore so the migrations + generated
// columns + json_extract semantics are exercised end-to-end. Time is
// injected via `now: () => fixedMs` so enqueued_at lands on a known
// boundary; the tests can pick predictable bucket alignment without
// depending on wall-clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import {
  decodeCursor,
  encodeCursor,
  getDrilldownPage,
  getHaltDistribution,
  getKpiTotals,
  getModelDistribution,
  getRunsByBucket,
  getSpendByBucket,
  getTokensByBucket,
  getTopWorkflows,
} from "../../src/store/analytics-queries.ts";

let store: SqliteStore;
let nowMs: number;

beforeEach(() => {
  // Anchor: 2026-04-28 12:00:00 UTC. Each test patches enqueued_at
  // directly via `seedRun`, so the store's `now()` doesn't need to
  // advance.
  nowMs = Date.UTC(2026, 3, 28, 12, 0, 0);
  nextRunId = 0;
  store = new SqliteStore({
    path: ":memory:",
    now: () => nowMs,
  });
  store.saveWorkflow("wf1", "build-feature", "digraph { a -> b }");
  store.saveWorkflow("wf2", "smoke", "digraph { x -> y }");
});

afterEach(() => {
  store.close();
});

/** Helper: seed a run with a specific `enqueued_at` ms. Writes the run
 *  through `enqueueRun` (so all the constraints hold) then patches the
 *  exact enqueued_at + metrics + status via the unsafe DB so the test
 *  doesn't depend on stepping the store's `now()` closure (which would
 *  also affect any later writes in the same call).
 */
function seedRun(opts: {
  workflowSha?: string;
  enqueuedAtMs: number;
  status?: "completed" | "halted" | "quarantined";
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  models?: Record<string, { tokens: number; costUsd: number }>;
}): string {
  const sha = opts.workflowSha ?? "wf1";
  nextRunId++;
  const runId = `run-${nextRunId}`;
  store.enqueueRun({ runId, workflowSha: sha });
  const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
  const metrics = JSON.stringify({
    totalCostUsd: opts.costUsd ?? 0,
    totalInputTokens: opts.inputTokens ?? 0,
    totalOutputTokens: opts.outputTokens ?? 0,
    totalCacheReadTokens: opts.cacheReadTokens ?? 0,
    totalCacheWriteTokens: 0,
    billedTokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0) + (opts.cacheReadTokens ?? 0),
    models: opts.models ?? {},
  });
  db.query(`UPDATE run_state SET enqueued_at = ?, metrics = ?, status = ? WHERE run_id = ?`).run(
    opts.enqueuedAtMs,
    metrics,
    opts.status ?? "completed",
    runId,
  );
  return runId;
}

let nextRunId = 0;

describe("getKpiTotals", () => {
  test("empty window returns zeros", () => {
    const totals = getKpiTotals((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: 0,
      toMs: nowMs,
    });
    expect(totals).toEqual({
      runs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("sums runs + cost + tokens within the window", () => {
    seedRun({ enqueuedAtMs: nowMs, costUsd: 1.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 });
    seedRun({ enqueuedAtMs: nowMs + 60_000, costUsd: 2.5, inputTokens: 200, outputTokens: 75 });
    const totals = getKpiTotals((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: nowMs - 1,
      toMs: nowMs + 120_000,
    });
    expect(totals.runs).toBe(2);
    expect(totals.costUsd).toBeCloseTo(4.0, 5);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(125);
    expect(totals.cacheReadTokens).toBe(10);
  });

  test("excludes runs outside the window", () => {
    seedRun({ enqueuedAtMs: nowMs - 86_400_000, costUsd: 99 }); // yesterday
    seedRun({ enqueuedAtMs: nowMs, costUsd: 1 });
    const totals = getKpiTotals((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: nowMs - 1,
      toMs: nowMs + 1,
    });
    expect(totals.runs).toBe(1);
    expect(totals.costUsd).toBeCloseTo(1, 5);
  });
});

describe("getRunsByBucket", () => {
  test("empty input → empty array", () => {
    const rows = getRunsByBucket((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: 0,
      toMs: nowMs,
      bucket: "hour",
      tzOffsetMinutes: 0,
    });
    expect(rows).toEqual([]);
  });

  test("groups runs by hour bucket and splits by outcome (UTC)", () => {
    // Two completed at 12:00 UTC, one halted at 13:00 UTC.
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 12, 5), status: "completed" });
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 12, 30), status: "completed" });
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 13, 10), status: "halted" });

    const rows = getRunsByBucket((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: Date.UTC(2026, 3, 28, 0),
      toMs: Date.UTC(2026, 3, 29, 0),
      bucket: "hour",
      tzOffsetMinutes: 0, // UTC
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      bucket: Date.UTC(2026, 3, 28, 12),
      completed: 2,
      queued: 0,
      running: 0,
      paused_hitl: 0,
      paused_provider_error: 0,
      paused_provider_retry: 0,
      paused_retry: 0,
      cancelled: 0,
      halted: 0,
      quarantined: 0,
    });
    expect(rows[1]).toEqual({
      bucket: Date.UTC(2026, 3, 28, 13),
      completed: 0,
      queued: 0,
      running: 0,
      paused_hitl: 0,
      paused_provider_error: 0,
      paused_provider_retry: 0,
      paused_retry: 0,
      cancelled: 0,
      halted: 1,
      quarantined: 0,
    });
  });

  test("day buckets shift by tz offset (PT, UTC-8 → tzOffsetMinutes=480)", () => {
    // 2026-04-28 04:00 UTC == 2026-04-27 20:00 PT → falls in PT-day "27".
    // 2026-04-28 12:00 UTC == 2026-04-28 04:00 PT → falls in PT-day "28".
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 4) });
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 12) });

    const rows = getRunsByBucket((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: 0,
      toMs: Date.UTC(2026, 3, 30),
      bucket: "day",
      tzOffsetMinutes: 480,
    });
    // Expect two buckets: PT-day-27 (UTC 27 08:00) and PT-day-28 (UTC 28 08:00).
    expect(rows).toHaveLength(2);
    expect(rows[0]?.bucket).toBe(Date.UTC(2026, 3, 27, 8));
    expect(rows[1]?.bucket).toBe(Date.UTC(2026, 3, 28, 8));
  });
});

describe("getSpendByBucket / getTokensByBucket", () => {
  test("aggregate cost and tokens per hour", () => {
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 10), costUsd: 1.5, inputTokens: 100, outputTokens: 25 });
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 10, 30), costUsd: 0.5, inputTokens: 50, outputTokens: 25 });
    seedRun({ enqueuedAtMs: Date.UTC(2026, 3, 28, 11), costUsd: 2.0, inputTokens: 200, outputTokens: 100 });

    const w = {
      fromMs: Date.UTC(2026, 3, 28, 9),
      toMs: Date.UTC(2026, 3, 28, 12),
      bucket: "hour" as const,
      tzOffsetMinutes: 0,
    };
    const spend = getSpendByBucket((store as unknown as { db: import("bun:sqlite").Database }).db, w);
    // The fallback ladder: when metrics has no recorded input/output
    // cost split (these seeds don't set one), the SQL splits each
    // run's `total_cost_usd` by the input/output token ratio. Sums
    // round-trip to `costUsd` per bucket. Bucket 10:00 holds
    // 1.5 USD * (100/125) + 0.5 USD * (50/75) = 1.2 + 0.333… = 1.533…
    // for input; the rest goes to output.
    expect(spend).toHaveLength(2);
    expect(spend[0]?.bucket).toBe(Date.UTC(2026, 3, 28, 10));
    expect(spend[0]?.costUsd).toBeCloseTo(2.0, 5);
    expect(spend[0]?.inputCostUsd).toBeCloseTo(1.5 * (100 / 125) + 0.5 * (50 / 75), 5);
    expect(spend[0]?.outputCostUsd).toBeCloseTo(1.5 * (25 / 125) + 0.5 * (25 / 75), 5);
    expect(spend[1]?.bucket).toBe(Date.UTC(2026, 3, 28, 11));
    expect(spend[1]?.costUsd).toBeCloseTo(2.0, 5);
    expect(spend[1]?.inputCostUsd).toBeCloseTo(2.0 * (200 / 300), 5);
    expect(spend[1]?.outputCostUsd).toBeCloseTo(2.0 * (100 / 300), 5);

    const tokens = getTokensByBucket((store as unknown as { db: import("bun:sqlite").Database }).db, w);
    expect(tokens).toEqual([
      { bucket: Date.UTC(2026, 3, 28, 10), inputTokens: 150, outputTokens: 50 },
      { bucket: Date.UTC(2026, 3, 28, 11), inputTokens: 200, outputTokens: 100 },
    ]);
  });
});

describe("getHaltDistribution", () => {
  test("groups by status, descending count", () => {
    seedRun({ enqueuedAtMs: nowMs, status: "completed" });
    seedRun({ enqueuedAtMs: nowMs, status: "completed" });
    seedRun({ enqueuedAtMs: nowMs, status: "halted" });
    const rows = getHaltDistribution((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: nowMs - 1,
      toMs: nowMs + 1,
    });
    expect(rows).toEqual([
      { status: "completed", count: 2 },
      { status: "halted", count: 1 },
    ]);
  });
});

describe("getModelDistribution", () => {
  test("pivots metrics.models via json_each, sums by key", () => {
    seedRun({
      enqueuedAtMs: nowMs,
      models: {
        "claude-opus-4-7": { tokens: 1000, costUsd: 1.0 },
        "claude-sonnet-4-6": { tokens: 500, costUsd: 0.2 },
      },
    });
    seedRun({
      enqueuedAtMs: nowMs,
      models: {
        "claude-opus-4-7": { tokens: 200, costUsd: 0.4 },
      },
    });
    const rows = getModelDistribution((store as unknown as { db: import("bun:sqlite").Database }).db, {
      fromMs: nowMs - 1,
      toMs: nowMs + 1,
    });
    expect(rows).toHaveLength(2);
    const opus = rows.find((r) => r.model === "claude-opus-4-7");
    const sonnet = rows.find((r) => r.model === "claude-sonnet-4-6");
    expect(opus?.tokens).toBe(1200);
    expect(opus?.costUsd).toBeCloseTo(1.4, 5);
    expect(sonnet?.tokens).toBe(500);
    // Order is by costUsd DESC.
    expect(rows[0]?.model).toBe("claude-opus-4-7");
  });
});

describe("getTopWorkflows", () => {
  test("groups by workflow_sha + joins workflows.name, ordered by run count", () => {
    seedRun({ workflowSha: "wf1", enqueuedAtMs: nowMs, status: "completed", costUsd: 1 });
    seedRun({ workflowSha: "wf1", enqueuedAtMs: nowMs, status: "halted", costUsd: 0.5 });
    seedRun({ workflowSha: "wf2", enqueuedAtMs: nowMs, status: "completed" });

    const rows = getTopWorkflows(
      (store as unknown as { db: import("bun:sqlite").Database }).db,
      {
        fromMs: nowMs - 1,
        toMs: nowMs + 1,
      },
      10,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.workflowSha).toBe("wf1");
    expect(rows[0]?.workflowName).toBe("build-feature");
    expect(rows[0]?.runs).toBe(2);
    expect(rows[0]?.success).toBe(1);
    expect(rows[0]?.fail).toBe(1);
    expect(rows[0]?.costUsd).toBeCloseTo(1.5, 5);
    expect(rows[1]?.workflowSha).toBe("wf2");
    expect(rows[1]?.runs).toBe(1);
  });
});

describe("getDrilldownPage", () => {
  test("returns runs in window, newest first, with cursor pagination", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(seedRun({ enqueuedAtMs: nowMs + i * 1000, status: "completed" }));
    }
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;

    const page1 = getDrilldownPage(db, { fromMs: nowMs - 1, toMs: nowMs + 10_000 }, { limit: 2 });
    expect(page1.runIds).toEqual([ids[4]!, ids[3]!]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = getDrilldownPage(
      db,
      { fromMs: nowMs - 1, toMs: nowMs + 10_000 },
      { limit: 2, cursor: page1.nextCursor! },
    );
    expect(page2.runIds).toEqual([ids[2]!, ids[1]!]);

    const page3 = getDrilldownPage(
      db,
      { fromMs: nowMs - 1, toMs: nowMs + 10_000 },
      { limit: 2, cursor: page2.nextCursor! },
    );
    expect(page3.runIds).toEqual([ids[0]!]);
    expect(page3.nextCursor).toBeNull();
  });

  test("filters by workflow + halt category", () => {
    seedRun({ workflowSha: "wf1", enqueuedAtMs: nowMs, status: "completed" });
    seedRun({ workflowSha: "wf1", enqueuedAtMs: nowMs, status: "halted" });
    const wf2id = seedRun({ workflowSha: "wf2", enqueuedAtMs: nowMs, status: "completed" });
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;

    const onlyWf2 = getDrilldownPage(db, { fromMs: nowMs - 1, toMs: nowMs + 1, workflowSha: "wf2" }, { limit: 10 });
    expect(onlyWf2.runIds).toEqual([wf2id]);

    const onlyHalted = getDrilldownPage(
      db,
      { fromMs: nowMs - 1, toMs: nowMs + 1, haltCategory: "failure" },
      { limit: 10 },
    );
    expect(onlyHalted.runIds).toHaveLength(1);
  });

  test("filters by model via json_each EXISTS", () => {
    const opusRunId = seedRun({
      enqueuedAtMs: nowMs,
      models: { "claude-opus-4-7": { tokens: 100, costUsd: 0.5 } },
    });
    seedRun({
      enqueuedAtMs: nowMs,
      models: { "claude-haiku-4-5": { tokens: 100, costUsd: 0.05 } },
    });
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;

    const onlyOpus = getDrilldownPage(
      db,
      { fromMs: nowMs - 1, toMs: nowMs + 1, model: "claude-opus-4-7" },
      { limit: 10 },
    );
    expect(onlyOpus.runIds).toEqual([opusRunId]);
  });
});

describe("cursor encode/decode", () => {
  test("round-trips via base64url", () => {
    const c = { enqueuedAt: 1714320000000, runId: "run-abc" };
    const encoded = encodeCursor(c);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(decodeCursor(encoded)).toEqual(c);
  });

  test("returns null on garbage input", () => {
    expect(decodeCursor("not-base64-!!@#")).toBeNull();
    expect(decodeCursor("aGVsbG8=")).toBeNull(); // valid b64 but wrong shape
  });
});
