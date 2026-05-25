// Unit tests for the SQL aggregations in src/queries.ts.
// Exercised against a real `:memory:` SQLite so the JSON-extract +
// window-function behaviour is hit end-to-end. Folding cost.recorded
// events in TypeScript silently dropped most of them on tool-using
// turns (one llm.start, multiple message_end → cost.recorded events,
// each fired AFTER its own llm.done) — these tests pin the new
// SQL window aggregation against the cases the old reducer broke on.

import { describe, expect, test } from "bun:test";
import type { ObservabilityEvent } from "../src/index.ts";
import { freshStore, seedRun, seedWorkflow } from "./helpers.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });

function startEv(nodeId: string, extras: Record<string, unknown> = {}): ObservabilityEvent {
  return { type: "llm.start", payload: { nodeId, iteration: 0, prompt: "p", ...extras } };
}
function doneEv(nodeId: string, extras: Record<string, unknown> = {}): ObservabilityEvent {
  return { type: "llm.done", payload: { nodeId, iteration: 0, ...extras } };
}
function costEv(nodeId: string, fields: Record<string, unknown>): ObservabilityEvent {
  return { type: "cost.recorded", payload: { nodeId, iteration: 0, ...fields } };
}

describe("getStepAggregates", () => {
  test("empty run → empty result", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getStepAggregates(runId)).toEqual([]);
    store.close();
  });

  test("one llm.start with one cost.recorded → that cost on that step", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.001 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.nodeId).toBe("n1");
    expect(a!.costUsd).toBeCloseTo(0.001);
    expect(a!.inputTokens).toBe(10);
    expect(a!.outputTokens).toBe(5);
    expect(a!.billedTokens).toBe(15);
    expect(a!.costEventCount).toBe(1);
    store.close();
  });

  test("cost.recorded AFTER llm.done still attributes to the step (the actual agent flow)", async () => {
    // Reproduces the screenshot-confirmed bug: tool-using turns emit
    // message_end → cost.recorded AFTER message_update(done) → llm.done.
    // The previous TS reducer closed the step on llm.done and dropped
    // every subsequent cost event, under-counting by ~10x on real runs.
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      doneEv("n1", { stop_reason: "tool_use" }),
      costEv("n1", { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost_usd: 0.01 }),
      doneEv("n1", { stop_reason: "tool_use" }),
      costEv("n1", { input_tokens: 200, output_tokens: 40, total_tokens: 240, cost_usd: 0.02 }),
      doneEv("n1", { stop_reason: "end_turn" }),
      costEv("n1", { input_tokens: 50, output_tokens: 10, total_tokens: 60, cost_usd: 0.005 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.costUsd).toBeCloseTo(0.035);
    expect(a!.inputTokens).toBe(350);
    expect(a!.outputTokens).toBe(70);
    expect(a!.billedTokens).toBe(420);
    expect(a!.costEventCount).toBe(3);
    expect(a!.stopReason).toBe("end_turn"); // last one wins
    store.close();
  });

  test("multiple cost.recorded events without llm.done all attribute (defensive)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 0.001 }),
      costEv("n1", { input_tokens: 2, output_tokens: 2, total_tokens: 4, cost_usd: 0.002 }),
      costEv("n1", { input_tokens: 3, output_tokens: 3, total_tokens: 6, cost_usd: 0.003 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.costUsd).toBeCloseTo(0.006);
    expect(a!.inputTokens).toBe(6);
    expect(a!.outputTokens).toBe(6);
    expect(a!.billedTokens).toBe(12);
    expect(a!.costEventCount).toBe(3);
    store.close();
  });

  test("loop iterations on the same nodeId produce one row per llm.start with split costs", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("body", { iteration: 1 }),
      costEv("body", { input_tokens: 10, output_tokens: 1, total_tokens: 11, cost_usd: 0.01 }),
      doneEv("body"),
      startEv("body", { iteration: 2 }),
      costEv("body", { input_tokens: 20, output_tokens: 2, total_tokens: 22, cost_usd: 0.02 }),
      doneEv("body"),
      startEv("body", { iteration: 3 }),
      costEv("body", { input_tokens: 30, output_tokens: 3, total_tokens: 33, cost_usd: 0.03 }),
    ]);
    const aggs = store.getStepAggregates(runId);
    expect(aggs.length).toBe(3);
    expect(aggs[0]!.costUsd).toBeCloseTo(0.01);
    expect(aggs[1]!.costUsd).toBeCloseTo(0.02);
    expect(aggs[2]!.costUsd).toBeCloseTo(0.03);
    expect(aggs[0]!.inputTokens).toBe(10);
    expect(aggs[1]!.inputTokens).toBe(20);
    expect(aggs[2]!.inputTokens).toBe(30);
    store.close();
  });

  test("interleaved nodes attribute costs to the right node", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("A"),
      startEv("B"),
      costEv("A", { input_tokens: 1, output_tokens: 0, cost_usd: 0.001 }),
      costEv("B", { input_tokens: 2, output_tokens: 0, cost_usd: 0.002 }),
      doneEv("A"),
      doneEv("B"),
    ]);
    const aggs = store.getStepAggregates(runId);
    const a = aggs.find((r) => r.nodeId === "A");
    const b = aggs.find((r) => r.nodeId === "B");
    expect(a!.costUsd).toBeCloseTo(0.001);
    expect(a!.inputTokens).toBe(1);
    expect(b!.costUsd).toBeCloseTo(0.002);
    expect(b!.inputTokens).toBe(2);
    store.close();
  });

  test("cost.recorded under a synthetic node (no llm.start) is excluded from step aggregates", async () => {
    // Summariser / title-generator emit cost.recorded directly under a
    // synthetic node id with no llm.start — these belong to the run
    // total but not to any step. They show up via getRunCostTotals.
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.01 }),
      // Summariser-style: cost.recorded under a node that never opened.
      costEv("__summary.title", { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.05 }),
    ]);
    const stepAggs = store.getStepAggregates(runId);
    expect(stepAggs).toHaveLength(1);
    expect(stepAggs[0]!.costUsd).toBeCloseTo(0.01);

    const totals = store.getRunCostTotals(runId);
    expect(totals.costUsd).toBeCloseTo(0.06);
    expect(totals.eventCount).toBe(2);
    store.close();
  });

  test("startSeq matches the actual events.seq of the originating llm.start", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const r = store.appendObservabilityEvents(runId, [startEv("n1"), startEv("n2")]);
    const aggs = store.getStepAggregates(runId);
    expect(aggs.map((a) => a.startSeq)).toEqual(r.seqs);
    store.close();
  });

  test("stopReason picks the LAST llm.done in the window, not the first", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      doneEv("n1", { stop_reason: "tool_use" }),
      doneEv("n1", { stop_reason: "tool_use" }),
      doneEv("n1", { stop_reason: "end_turn" }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.stopReason).toBe("end_turn");
    store.close();
  });

  test("missing token sub-fields default to 0 (sums coalesce nulls)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      // No cache_read_tokens / cache_write_tokens fields at all.
      costEv("n1", { input_tokens: 5, output_tokens: 2, cost_usd: 0.001 }),
    ]);
    const [a] = store.getStepAggregates(runId);
    expect(a!.cacheReadTokens).toBe(0);
    expect(a!.cacheWriteTokens).toBe(0);
    expect(a!.billedTokens).toBe(0);
    store.close();
  });
});

describe("listRunSummaryRows", () => {
  test("projects summary fields without hydrating event logs", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [{ type: "run.title_generated", payload: { title: "Generated title" } }]);

    const [row] = store.listRunSummaryRows();
    expect(row!.runId).toBe(runId);
    expect(row!.workflowName).toBe("test");
    expect(row!.eventCount).toBe(2);
    expect(row!.firstEventTs).toBeLessThan(row!.lastEventTs!);
    expect(row!.eventTitle).toBe("Generated title");
    expect(row!.totalCostUsd).toBe(0);
    store.close();
  });
});

describe("getGlobalEventsForward", () => {
  // Use FEED_EVENT_KINDS-shaped allow-list so the query engine sees the
  // realistic set. `intent.run_enqueued` is the most convenient seed —
  // enqueueRun emits one per run.
  const KINDS = ["intent.run_enqueued", "fact.run_started", "fact.run_completed"] as const;

  test("empty store → empty result", () => {
    const store = freshStore();
    const out = store.getGlobalEventsForward({
      floorTs: 0,
      lastRunId: "",
      lastSeq: -1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(out).toEqual([]);
    store.close();
  });

  test('first-connect sentinel `("", -1)` includes all events at floorTs', async () => {
    const t = 5_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    store.enqueueRun({ runId: "z", workflowSha: "wf" });

    const out = store.getGlobalEventsForward({
      floorTs: t,
      lastRunId: "",
      lastSeq: -1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(out.map((e) => e.runId)).toEqual(["a", "z"]);
    store.close();
  });

  test("strict-tuple cursor: `> (ts, runId, seq)` excludes the cursor row", async () => {
    const t = 6_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    store.enqueueRun({ runId: "m", workflowSha: "wf" });
    store.enqueueRun({ runId: "z", workflowSha: "wf" });

    // Cursor at (t, "m", 1) — only "z" should come back.
    const out = store.getGlobalEventsForward({
      floorTs: t,
      lastRunId: "m",
      lastSeq: 1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(out.map((e) => e.runId)).toEqual(["z"]);
    store.close();
  });

  test("advances within same ts when LIMIT clips: pagination is monotonic", async () => {
    // Seed N=3 events at the same ts. With LIMIT 1 the cursor must
    // step through them one at a time without stalling — the very
    // failure mode the redesign fixes (the old `ts >= ?` + Set kept
    // returning the same first row forever).
    const t = 7_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "r1", workflowSha: "wf" });
    store.enqueueRun({ runId: "r2", workflowSha: "wf" });
    store.enqueueRun({ runId: "r3", workflowSha: "wf" });

    const collected: string[] = [];
    let cur = { lastRunId: "", lastSeq: -1 };
    for (let i = 0; i < 5; i++) {
      const batch = store.getGlobalEventsForward({
        floorTs: t,
        lastRunId: cur.lastRunId,
        lastSeq: cur.lastSeq,
        kindIn: KINDS,
        limit: 1,
      });
      if (batch.length === 0) break;
      for (const ev of batch) {
        collected.push(ev.runId);
        cur = { lastRunId: ev.runId, lastSeq: ev.seq };
      }
    }
    expect(collected).toEqual(["r1", "r2", "r3"]);
    store.close();
  });

  test("kindIn filter excludes non-matching event types", async () => {
    const t = 8_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "r1", workflowSha: "wf" });

    // intent.run_enqueued is in KINDS; querying with an empty allow-list
    // (or one missing the type) should return nothing.
    const out = store.getGlobalEventsForward({
      floorTs: 0,
      lastRunId: "",
      lastSeq: -1,
      kindIn: ["fact.run_started"],
      limit: 100,
    });
    expect(out).toEqual([]);
    store.close();
  });
});

describe("getGlobalEventsAtFloor", () => {
  const KINDS = ["intent.run_enqueued"] as const;

  test("returns events at exactly `floorTs`, paginated by `(runId, seq) > cursor`", async () => {
    // Three runs at the same ts. The full-boundary cursor `("", -1)`
    // returns all three; advancing the cursor narrows the window.
    const t = 9_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    store.enqueueRun({ runId: "m", workflowSha: "wf" });
    store.enqueueRun({ runId: "z", workflowSha: "wf" });

    const all = store.getGlobalEventsAtFloor({
      floorTs: t,
      afterRunId: "",
      afterSeq: -1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(all.map((e) => e.runId)).toEqual(["a", "m", "z"]);

    const afterM = store.getGlobalEventsAtFloor({
      floorTs: t,
      afterRunId: "m",
      afterSeq: 1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(afterM.map((e) => e.runId)).toEqual(["z"]);
    store.close();
  });

  test("ignores events at other `ts` values", async () => {
    // One event at t1, two at t2. A scan at `floorTs=t2` returns only
    // t2's events, even though t1's is lex-smaller in `(run_id, seq)`.
    let t = 10_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    t = 10_000_001;
    store.enqueueRun({ runId: "b", workflowSha: "wf" });
    store.enqueueRun({ runId: "z", workflowSha: "wf" });

    const out = store.getGlobalEventsAtFloor({
      floorTs: 10_000_001,
      afterRunId: "",
      afterSeq: -1,
      kindIn: KINDS,
      limit: 100,
    });
    expect(out.map((e) => e.runId)).toEqual(["b", "z"]);
    store.close();
  });

  test("kindIn filter excludes non-matching event types", async () => {
    const t = 11_000_000;
    const store = new (await import("../src/index.ts")).SqliteStore({ path: ":memory:", now: () => t });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    store.enqueueRun({ runId: "z", workflowSha: "wf" });

    const out = store.getGlobalEventsAtFloor({
      floorTs: t,
      afterRunId: "",
      afterSeq: -1,
      kindIn: ["fact.run_started"],
      limit: 100,
    });
    expect(out).toEqual([]);
    store.close();
  });
});

describe("getRunCostTotals", () => {
  test("empty run → zero row", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const r = store.getRunCostTotals(runId);
    expect(r.costUsd).toBe(0);
    expect(r.eventCount).toBe(0);
    store.close();
  });

  test("sums every cost.recorded regardless of llm.start containment", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendObservabilityEvents(runId, [
      startEv("n1"),
      costEv("n1", { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 }),
      doneEv("n1"),
      costEv("n1", { input_tokens: 2, output_tokens: 2, cost_usd: 0.02 }),
      // Synthetic — outside any step window:
      costEv("__summary", { input_tokens: 3, output_tokens: 3, cost_usd: 0.03 }),
    ]);
    const totals = store.getRunCostTotals(runId);
    expect(totals.costUsd).toBeCloseTo(0.06);
    expect(totals.inputTokens).toBe(6);
    expect(totals.outputTokens).toBe(6);
    expect(totals.eventCount).toBe(3);
    store.close();
  });
});

describe("listRunIds + listCwds — cwd surface", () => {
  test("listRunIds({cwd}) narrows to one project root", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    store.enqueueRun({ runId: "a1", workflowSha: wf, cwd: "/repos/alpha" });
    store.enqueueRun({ runId: "a2", workflowSha: wf, cwd: "/repos/alpha" });
    store.enqueueRun({ runId: "b1", workflowSha: wf, cwd: "/repos/beta" });
    store.enqueueRun({ runId: "n1", workflowSha: wf });

    expect(new Set(store.listRunIds({ cwd: "/repos/alpha" }))).toEqual(new Set(["a1", "a2"]));
    expect(store.listRunIds({ cwd: "/repos/beta" })).toEqual(["b1"]);
    expect(store.listRunIds({ cwd: "/nope" })).toEqual([]);
    expect(store.listRunIds().length).toBe(4);
    store.close();
  });

  test("listRunIds combines cwd + statuses", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    store.enqueueRun({ runId: "a1", workflowSha: wf, cwd: "/repos/alpha" });
    store.enqueueRun({ runId: "a2", workflowSha: wf, cwd: "/repos/alpha" });
    expect(store.listRunIds({ cwd: "/repos/alpha", statuses: ["queued"] })).toHaveLength(2);
    expect(store.listRunIds({ cwd: "/repos/alpha", statuses: ["completed"] })).toHaveLength(0);
    store.close();
  });

  test("listCwds groups runs by cwd, omits NULL, orders by recency", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    store.enqueueRun({ runId: "a1", workflowSha: wf, cwd: "/repos/alpha" });
    store.enqueueRun({ runId: "b1", workflowSha: wf, cwd: "/repos/beta" });
    store.enqueueRun({ runId: "a2", workflowSha: wf, cwd: "/repos/alpha" });
    store.enqueueRun({ runId: "n1", workflowSha: wf });

    const rows = store.listCwds();
    expect(rows.map((r) => r.cwd)).toEqual(["/repos/alpha", "/repos/beta"]);
    const alpha = rows.find((r) => r.cwd === "/repos/alpha");
    expect(alpha?.runCount).toBe(2);
    expect(rows[0]?.cwd).toBe("/repos/alpha");
    store.close();
  });
});

describe("project identity — project_id / project_name", () => {
  test("listProjects groups by project_id with label + cwd hint, regardless of cwd", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    // Same project id enqueued from two different cwds (a repo cloned twice
    // / imported) folds into ONE project; cwd hint is the most-recent.
    store.enqueueRun({ runId: "p1", workflowSha: wf, cwd: "/box-a/api", projectId: "proj-1", projectName: "api" });
    store.enqueueRun({ runId: "p2", workflowSha: wf, cwd: "/box-b/api", projectId: "proj-1", projectName: "api" });
    // An imported-only run: no local cwd, but a real identity + label.
    store.enqueueRun({ runId: "p3", workflowSha: wf, projectId: "proj-2", projectName: "web" });

    const rows = store.listProjects();
    expect(rows.map((r) => r.projectId).sort()).toEqual(["proj-1", "proj-2"]);
    const p1 = rows.find((r) => r.projectId === "proj-1");
    expect(p1?.projectName).toBe("api");
    expect(p1?.runCount).toBe(2);
    expect(p1?.cwdHint).toBe("/box-b/api");
    const p2 = rows.find((r) => r.projectId === "proj-2");
    expect(p2?.projectName).toBe("web");
    expect(p2?.cwdHint).toBeNull(); // imported-only — no local checkout
    store.close();
  });

  test("listRunIds({projectId}) narrows by identity, not location", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    store.enqueueRun({ runId: "a1", workflowSha: wf, cwd: "/box-a/api", projectId: "proj-1" });
    store.enqueueRun({ runId: "a2", workflowSha: wf, cwd: "/box-b/api", projectId: "proj-1" });
    store.enqueueRun({ runId: "b1", workflowSha: wf, cwd: "/box-a/web", projectId: "proj-2" });

    expect(new Set(store.listRunIds({ projectId: "proj-1" }))).toEqual(new Set(["a1", "a2"]));
    expect(store.listRunIds({ projectId: "proj-2" })).toEqual(["b1"]);
    store.close();
  });

  test("explicit projectId/projectName flow onto the run row; cwd default applies otherwise", async () => {
    const store = freshStore();
    const wf = await seedWorkflow(store);
    store.enqueueRun({ runId: "explicit", workflowSha: wf, cwd: "/x/y", projectId: "id-7", projectName: "seven" });
    store.enqueueRun({ runId: "fallback", workflowSha: wf, cwd: "/repos/alpha" });

    const explicit = store.listRunSummaryRows().find((r) => r.runId === "explicit");
    expect(explicit?.projectId).toBe("id-7");
    expect(explicit?.projectName).toBe("seven");
    const fallback = store.listRunSummaryRows().find((r) => r.runId === "fallback");
    expect(fallback?.projectId).toBe("/repos/alpha"); // cwd fallback
    expect(fallback?.projectName).toBe("alpha"); // basename fallback
    store.close();
  });
});

describe("getSnapshotEvents", () => {
  test("empty array for run with no snapshots", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getSnapshotEvents(runId)).toEqual([]);
    store.close();
  });

  test("returns snapshot.captured + fact.snapshot_recorded in seq order", async () => {
    const store = freshStore();
    const runId = await seedRun(store);

    // Seed unrelated facts first (should be filtered out)
    const state = store.getState(runId);
    if (state == null) throw new Error("no state");
    store.appendFact(
      runId,
      [{ type: "fact.run_started", payload: { workflowSha: "wf", contractVersion: 1, startNode: "n1" } }],
      state.version,
    );

    // Two snapshot.captured observability events
    store.appendObservabilityEvents(runId, [
      {
        type: "snapshot.captured",
        payload: {
          runId,
          eventIdx: 2,
          nodeId: "step1",
          treeSha: "tree1",
          commitSha: "commit1",
          parentSnap: "",
          headSha: null,
        },
      },
      {
        type: "snapshot.captured",
        payload: {
          runId,
          eventIdx: 3,
          nodeId: null,
          treeSha: "tree2",
          commitSha: "commit2",
          parentSnap: "commit1",
          headSha: null,
        },
      },
    ]);

    // One terminal fact.snapshot_recorded
    const state2 = store.getState(runId);
    if (state2 == null) throw new Error("no state");
    store.appendFact(
      runId,
      [
        {
          type: "fact.snapshot_recorded",
          payload: {
            eventIdx: 4,
            treeSha: "tree3",
            commitSha: "commit3",
            parentSnap: "commit2",
            headSha: null,
            headRef: null,
            diffBaseSha: "base0",
            committed: null,
            uncommitted: null,
          },
        },
      ],
      state2.version,
    );

    const events = store.getSnapshotEvents(runId);
    expect(events.length).toBe(3);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["snapshot.captured", "snapshot.captured", "fact.snapshot_recorded"]);

    // Must be in ascending seq order
    const seqs = events.map((e) => e.seq);
    expect(seqs[0]! < seqs[1]!).toBe(true);
    expect(seqs[1]! < seqs[2]!).toBe(true);

    store.close();
  });
});
