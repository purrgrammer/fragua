// Integration tests for the /analytics + /analytics/runs HTTP routes.
//
// Two concerns covered here that the store-level analytics-queries tests
// can't reach:
//   - The Hono route correctly parses + propagates `?cwd=` through to
//     both the totals/buckets queries and the drill-down query.
//   - End-to-end shape of the JSON payload matches what the dashboard
//     expects (totals + bucket arrays present).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { Hono } from "hono";
import { analyticsRoutes } from "../../src/store/analytics-routes.ts";

let store: SqliteStore;
let app: Hono;
let nextRunId = 0;
const NOW_MS = Date.UTC(2026, 3, 28, 12, 0, 0);

beforeEach(() => {
  nextRunId = 0;
  store = new SqliteStore({ path: ":memory:", now: () => NOW_MS });
  store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
  app = new Hono();
  app.route("/", analyticsRoutes({ store }));
});

afterEach(() => {
  store.close();
});

function seedRun(opts: {
  cwd?: string;
  costUsd?: number;
  status?: "completed" | "halted";
  workflowScope?: "global" | "local" | "path" | "ephemeral";
  workflowName?: string;
}): string {
  nextRunId++;
  const runId = `run-${nextRunId}`;
  store.enqueueRun({ runId, workflowSha: "wf" });
  const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
  const metrics = JSON.stringify({
    totalCostUsd: opts.costUsd ?? 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    billedTokens: 0,
    models: {},
  });
  db.query(
    `UPDATE run_state
       SET enqueued_at = ?, metrics = ?, status = ?, cwd = ?,
           workflow_scope = ?, workflow_name = ?
       WHERE run_id = ?`,
  ).run(
    NOW_MS,
    metrics,
    opts.status ?? "completed",
    opts.cwd ?? null,
    opts.workflowScope ?? null,
    opts.workflowName ?? null,
    runId,
  );
  return runId;
}

describe("GET /analytics ?cwd=", () => {
  test("filters totals + buckets to the requested project", async () => {
    seedRun({ cwd: "/proj/a", costUsd: 1 });
    seedRun({ cwd: "/proj/a", costUsd: 2 });
    seedRun({ cwd: "/proj/b", costUsd: 99 });

    const url = `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0&cwd=${encodeURIComponent("/proj/a")}`;
    const res = await app.fetch(new Request(`http://t${url}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { current: { runs: number; costUsd: number } };
      runsByBucket: Array<{ completed: number }>;
    };
    expect(body.totals.current.runs).toBe(2);
    expect(body.totals.current.costUsd).toBeCloseTo(3, 5);
    expect(body.runsByBucket).toHaveLength(1);
    expect(body.runsByBucket[0]?.completed).toBe(2);
  });

  test("absent cwd aggregates across every project (back-compat)", async () => {
    seedRun({ cwd: "/proj/a", costUsd: 1 });
    seedRun({ cwd: "/proj/b", costUsd: 2 });

    const url = `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0`;
    const res = await app.fetch(new Request(`http://t${url}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { current: { runs: number; costUsd: number } } };
    expect(body.totals.current.runs).toBe(2);
    expect(body.totals.current.costUsd).toBeCloseTo(3, 5);
  });
});

describe("GET /analytics/runs ?cwd=", () => {
  test("drilldown page is scoped to the cwd", async () => {
    const aId = seedRun({ cwd: "/proj/a" });
    seedRun({ cwd: "/proj/b" });
    seedRun({ cwd: "/proj/b" });

    const url = `/analytics/runs?from=${NOW_MS - 1}&to=${NOW_MS + 1}&cwd=${encodeURIComponent("/proj/a")}`;
    const res = await app.fetch(new Request(`http://t${url}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ runId: string }> };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.runId).toBe(aId);
  });
});

describe("GET /analytics ?workflowScope=&workflowName=", () => {
  test("scopes totals + buckets to a workflow lineage", async () => {
    seedRun({ costUsd: 1, workflowScope: "global", workflowName: "research" });
    seedRun({ costUsd: 2, workflowScope: "global", workflowName: "research" });
    seedRun({ costUsd: 99, workflowScope: "global", workflowName: "ci" });

    const url =
      `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0` +
      `&workflowScope=global&workflowName=research`;
    const res = await app.fetch(new Request(`http://t${url}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { current: { runs: number; costUsd: number } } };
    expect(body.totals.current.runs).toBe(2);
    expect(body.totals.current.costUsd).toBeCloseTo(3, 5);
  });

  test("rejects scope without name (and vice-versa)", async () => {
    const onlyScope = `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0&workflowScope=global`;
    const r1 = await app.fetch(new Request(`http://t${onlyScope}`));
    expect(r1.status).toBe(400);

    const onlyName = `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0&workflowName=research`;
    const r2 = await app.fetch(new Request(`http://t${onlyName}`));
    expect(r2.status).toBe(400);
  });

  test("rejects unknown scope literal", async () => {
    const url =
      `/analytics?from=${NOW_MS - 1}&to=${NOW_MS + 1}&bucket=hour&tzOffsetMinutes=0` +
      `&workflowScope=path&workflowName=research`;
    const res = await app.fetch(new Request(`http://t${url}`));
    // 'path' isn't a user-iterable identity (no canonical name on
    // run_state); the route rejects it rather than silently zeroing.
    expect(res.status).toBe(400);
  });
});

describe("GET /analytics/workflows", () => {
  test("returns global + local identities, sha-collapsed", async () => {
    seedRun({ workflowScope: "global", workflowName: "research", cwd: "/proj/a" });
    seedRun({ workflowScope: "global", workflowName: "research", cwd: "/proj/b" });
    seedRun({ workflowScope: "local", workflowName: "triage", cwd: "/proj/a" });

    const res = await app.fetch(new Request(`http://t/analytics/workflows`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ scope: string; name: string; cwd: string | null; runCount: number }>;
    };
    const research = body.workflows.find((w) => w.scope === "global" && w.name === "research");
    expect(research?.runCount).toBe(2);
    expect(research?.cwd).toBeNull();
    const triage = body.workflows.find((w) => w.scope === "local" && w.name === "triage");
    expect(triage?.cwd).toBe("/proj/a");
  });

  test("?cwd= scopes locals to one project; globals always returned", async () => {
    seedRun({ workflowScope: "global", workflowName: "research" });
    seedRun({ workflowScope: "local", workflowName: "triage", cwd: "/proj/a" });
    seedRun({ workflowScope: "local", workflowName: "triage", cwd: "/proj/b" });

    const res = await app.fetch(new Request(`http://t/analytics/workflows?cwd=${encodeURIComponent("/proj/a")}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workflows: Array<{ scope: string; name: string; cwd: string | null }>;
    };
    expect(body.workflows.filter((w) => w.scope === "local")).toHaveLength(1);
    expect(body.workflows.find((w) => w.scope === "local")?.cwd).toBe("/proj/a");
    expect(body.workflows.some((w) => w.scope === "global")).toBe(true);
  });
});
