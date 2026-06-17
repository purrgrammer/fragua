import { describe, expect, test } from "bun:test";
import { RUN_STATUSES, type RunStatus, type SqliteStore } from "../src/index.ts";
import { freshStore, seedWorkflow } from "./helpers.ts";

/** Drive a fresh run to `status`, optionally folding `costUsd` into its
 *  metrics first (via a `node_completed` fact, the production cost path). */
function driveRun(
  store: SqliteStore,
  opts: { runId: string; workflowSha: string; workflowName: string; status: RunStatus; costUsd?: number },
): void {
  const { runId, workflowSha, workflowName, status, costUsd } = opts;
  store.enqueueRun({ runId, workflowSha, workflowName });
  if (status === "queued") return;

  let v = store.appendFact(
    runId,
    [{ type: "fact.run_started", payload: { workflowSha, contractVersion: 1, startNode: "a" } }],
    store.getState(runId)!.version,
  ).newVersion;

  if (costUsd != null && costUsd > 0) {
    v = store.appendFact(
      runId,
      [
        {
          type: "fact.node_completed",
          payload: { nodeId: "a", iteration: 0, tokens: 10, costUsd, modelName: "m", nextNode: "b" },
        },
      ],
      v,
    ).newVersion;
  }

  switch (status) {
    case "running":
      return;
    case "completed":
      store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "a" } }], v);
      return;
    case "halted":
      store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "errored", reason: "error" } }], v);
      return;
    case "cancelled":
      store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 2 } }], v);
      return;
    case "paused_human":
      store.appendFact(
        runId,
        [{ type: "fact.run_paused", payload: { reason: "human", nodeId: "a", text: "choose", routes: ["ok"] } }],
        v,
      );
      return;
    default:
      throw new Error(`driveRun: unsupported status ${status}`);
  }
}

const ZERO_COUNTS = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;

describe("selectFleetSummary", () => {
  test("empty store returns zeroed counts, no workflow rows, zero in-flight cost", async () => {
    const store = freshStore();
    await seedWorkflow(store);
    const summary = store.fleetSummary();
    expect(summary.statusCounts).toEqual(ZERO_COUNTS);
    expect(summary.workflows).toEqual([]);
    expect(summary.inFlightCostUsd).toBe(0);
    expect(summary.totalRuns).toBe(0);
    store.close();
  });

  test("mixed statuses bucket into the status-count line", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    driveRun(store, { runId: "q1", workflowSha: wf, workflowName: "alpha", status: "queued" });
    driveRun(store, { runId: "r1", workflowSha: wf, workflowName: "alpha", status: "running" });
    driveRun(store, { runId: "r2", workflowSha: wf, workflowName: "alpha", status: "running" });
    driveRun(store, { runId: "c1", workflowSha: wf, workflowName: "alpha", status: "completed" });
    driveRun(store, { runId: "h1", workflowSha: wf, workflowName: "alpha", status: "halted" });
    driveRun(store, { runId: "p1", workflowSha: wf, workflowName: "alpha", status: "paused_human" });

    const summary = store.fleetSummary();
    expect(summary.statusCounts.queued).toBe(1);
    expect(summary.statusCounts.running).toBe(2);
    expect(summary.statusCounts.completed).toBe(1);
    expect(summary.statusCounts.halted).toBe(1);
    expect(summary.statusCounts.paused_human).toBe(1);
    expect(summary.statusCounts.cancelled).toBe(0);
    expect(summary.totalRuns).toBe(6);
    store.close();
  });

  test("per-workflow breakdown splits running / done / failed by workflow_name", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    driveRun(store, { runId: "a1", workflowSha: wf, workflowName: "alpha", status: "running" });
    driveRun(store, { runId: "a2", workflowSha: wf, workflowName: "alpha", status: "completed" });
    driveRun(store, { runId: "a3", workflowSha: wf, workflowName: "alpha", status: "halted" });
    driveRun(store, { runId: "b1", workflowSha: wf, workflowName: "beta", status: "running" });
    driveRun(store, { runId: "b2", workflowSha: wf, workflowName: "beta", status: "cancelled" });

    const summary = store.fleetSummary();
    const alpha = summary.workflows.find((w) => w.workflow === "alpha");
    const beta = summary.workflows.find((w) => w.workflow === "beta");
    expect(alpha).toEqual({ workflow: "alpha", running: 1, done: 1, failed: 1, total: 3 });
    expect(beta).toEqual({ workflow: "beta", running: 1, done: 0, failed: 1, total: 2 });
    // Busiest-first ordering.
    expect(summary.workflows[0]?.workflow).toBe("alpha");
    store.close();
  });

  test("in-flight cost sums total_cost_usd over non-terminal runs only", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    driveRun(store, { runId: "r1", workflowSha: wf, workflowName: "alpha", status: "running", costUsd: 0.02 });
    driveRun(store, { runId: "p1", workflowSha: wf, workflowName: "alpha", status: "paused_human", costUsd: 0.03 });
    // Terminal runs carry cost too, but must be excluded from the live burn.
    driveRun(store, { runId: "c1", workflowSha: wf, workflowName: "alpha", status: "completed", costUsd: 1.0 });
    driveRun(store, { runId: "h1", workflowSha: wf, workflowName: "alpha", status: "halted", costUsd: 2.0 });

    const summary = store.fleetSummary();
    expect(summary.inFlightCostUsd).toBeCloseTo(0.05, 6);
    store.close();
  });

  test("respects --status filter as scope", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    driveRun(store, { runId: "r1", workflowSha: wf, workflowName: "alpha", status: "running", costUsd: 0.1 });
    driveRun(store, { runId: "c1", workflowSha: wf, workflowName: "alpha", status: "completed", costUsd: 5.0 });

    const summary = store.fleetSummary({ statuses: ["running"] });
    expect(summary.totalRuns).toBe(1);
    expect(summary.statusCounts.running).toBe(1);
    expect(summary.statusCounts.completed).toBe(0);
    expect(summary.inFlightCostUsd).toBeCloseTo(0.1, 6);

    // Empty status set short-circuits to an empty summary.
    const none = store.fleetSummary({ statuses: [] });
    expect(none.totalRuns).toBe(0);
    expect(none.workflows).toEqual([]);
    store.close();
  });

  test("--limit scopes the aggregated set to the most-recent runs", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    driveRun(store, { runId: "r1", workflowSha: wf, workflowName: "alpha", status: "running" });
    driveRun(store, { runId: "r2", workflowSha: wf, workflowName: "alpha", status: "running" });
    driveRun(store, { runId: "r3", workflowSha: wf, workflowName: "alpha", status: "running" });

    const summary = store.fleetSummary({ limit: 2 });
    expect(summary.totalRuns).toBe(2);
    expect(summary.statusCounts.running).toBe(2);
    store.close();
  });
});
