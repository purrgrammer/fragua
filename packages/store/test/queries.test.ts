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

    const [row] = store.listRunSummaryRows({ topLevelOnly: true });
    expect(row!.runId).toBe(runId);
    expect(row!.workflowName).toBe("test");
    expect(row!.eventCount).toBe(2);
    expect(row!.firstEventTs).toBeLessThan(row!.lastEventTs!);
    expect(row!.eventTitle).toBe("Generated title");
    expect(row!.totalCostUsd).toBe(0);
    store.close();
  });

  test("top-level summaries exclude child runs before applying limit", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: "parent", workflowSha: sha });
    store.enqueueRun({
      runId: "child",
      workflowSha: sha,
      parentRunId: "parent",
      parentNodeId: "fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "branch_a",
      subgraphTerminalNodeId: "join",
    });

    expect(store.listRunSummaryRows({ topLevelOnly: true, limit: 10 }).map((r) => r.runId)).toEqual(["parent"]);
    const [child] = store.listRunSummaryRows({ parentRunId: "parent" });
    expect(child!.runId).toBe("child");
    expect(child!.parentTitle).toBeNull();
    expect(child!.branchNodeId).toBe("branch_a");
    store.close();
  });

  test("child summaries include parent title fallback", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: "parent", workflowSha: sha });
    store.setRunTitle("parent", "Parent title");
    store.enqueueRun({
      runId: "child",
      workflowSha: sha,
      parentRunId: "parent",
      parentNodeId: "fanout",
      parallelIndex: 1,
      subgraphRootNodeId: "branch_b",
      subgraphTerminalNodeId: "join",
    });

    const [child] = store.listRunSummaryRows({ parentRunId: "parent" });
    expect(child!.parentTitle).toBe("Parent title");
    expect(child!.parallelIndex).toBe(1);
    store.close();
  });

  test("includeChildAttention widens status filter to surface parents whose descendants need attention", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    // Two parents: A in running_children with a paused child; B running
    // cleanly with a completed child.
    store.enqueueRun({ runId: "pA", workflowSha: sha });
    store.enqueueRun({ runId: "pB", workflowSha: sha });
    store.enqueueRun({
      runId: "pA_child",
      workflowSha: sha,
      parentRunId: "pA",
      parentNodeId: "fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "branch_a",
      subgraphTerminalNodeId: "join",
    });
    store.enqueueRun({
      runId: "pB_child",
      workflowSha: sha,
      parentRunId: "pB",
      parentNodeId: "fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "branch_b",
      subgraphTerminalNodeId: "join",
    });
    store.enqueueRun({
      runId: "pA_grandchild",
      workflowSha: sha,
      parentRunId: "pA_child",
      parentNodeId: "nested",
      parallelIndex: 0,
      subgraphRootNodeId: "nested_branch",
      subgraphTerminalNodeId: "join",
    });
    const db = (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'running_children' WHERE run_id = ?").run("pA");
    db.query("UPDATE run_state SET status = 'running'          WHERE run_id = ?").run("pB");
    db.query("UPDATE run_state SET status = 'running_children' WHERE run_id = ?").run("pA_child");
    db.query("UPDATE run_state SET status = 'paused'           WHERE run_id = ?").run("pA_grandchild");
    db.query("UPDATE run_state SET status = 'completed'        WHERE run_id = ?").run("pB_child");

    // Without the widen, status=paused returns nothing top-level.
    const narrow = store.listRunSummaryRows({ statuses: ["paused"], topLevelOnly: true });
    expect(narrow.map((r) => r.runId)).toEqual([]);

    // With the widen, pA surfaces because its grandchild is paused; pB
    // doesn't (its child is completed, no attention).
    const wide = store.listRunSummaryRows({
      statuses: ["paused"],
      topLevelOnly: true,
      includeChildAttention: true,
    });
    expect(wide.map((r) => r.runId)).toEqual(["pA"]);
    store.close();
  });

  test("parent rows carry a descendant-status digest aggregated by status", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: "p_digest", workflowSha: sha });
    for (const [i, name] of ["a", "b", "c"].entries()) {
      store.enqueueRun({
        runId: `p_digest__${name}`,
        workflowSha: sha,
        parentRunId: "p_digest",
        parentNodeId: "fanout",
        parallelIndex: i,
        subgraphRootNodeId: `branch_${name}`,
        subgraphTerminalNodeId: "join",
      });
    }
    store.enqueueRun({
      runId: "p_digest__b__nested",
      workflowSha: sha,
      parentRunId: "p_digest__b",
      parentNodeId: "nested",
      parallelIndex: 0,
      subgraphRootNodeId: "branch_nested",
      subgraphTerminalNodeId: "join",
    });
    // Force the three children into distinct statuses via the DB layer
    // (mimicking what the executor would do across the lifecycle).
    const db = (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = 'completed' WHERE run_id = ?").run("p_digest__a");
    db.query("UPDATE run_state SET status = 'paused'    WHERE run_id = ?").run("p_digest__b");
    db.query("UPDATE run_state SET status = 'running'   WHERE run_id = ?").run("p_digest__c");
    db.query("UPDATE run_state SET status = 'paused_hitl' WHERE run_id = ?").run("p_digest__b__nested");

    const [parent] = store.listRunSummaryRows({ topLevelOnly: true });
    expect(parent!.runId).toBe("p_digest");
    expect(parent!.childTotal).toBe(4);
    expect(parent!.childCompleted).toBe(1);
    expect(parent!.childPaused).toBe(1);
    expect(parent!.childRunning).toBe(1);
    expect(parent!.childPausedHitl).toBe(1);

    // Child rows include their own descendants.
    const children = store.listRunSummaryRows({ parentRunId: "p_digest" });
    expect(children.find((c) => c.runId === "p_digest__b")!.childTotal).toBe(1);
    expect(children.find((c) => c.runId === "p_digest__a")!.childTotal).toBeNull();
    store.close();
  });
});

describe("getMessagesNarrowWithDescendants", () => {
  test("orders rows by append event time rather than per-run ordinal", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: "msg_parent", workflowSha: sha });
    store.enqueueRun({
      runId: "msg_child",
      workflowSha: sha,
      parentRunId: "msg_parent",
      parentNodeId: "fanout",
      parallelIndex: 0,
      subgraphRootNodeId: "branch",
      subgraphTerminalNodeId: "join",
    });

    store.appendMessage("msg_parent", {
      content: { role: "user", content: [{ type: "text", text: "parent one" }], timestamp: 1 },
      nodeId: "fanout",
      iteration: 0,
    });
    store.appendMessage("msg_parent", {
      content: { role: "user", content: [{ type: "text", text: "parent two" }], timestamp: 2 },
      nodeId: "fanout",
      iteration: 0,
    });
    store.appendMessage("msg_child", {
      content: { role: "user", content: [{ type: "text", text: "child one" }], timestamp: 3 },
      nodeId: "branch",
      iteration: 0,
    });

    const rows = store.getMessagesNarrowWithDescendants("msg_parent");
    expect(rows.map((r) => `${r.originRunId}:${r.ordinal}`)).toEqual(["msg_parent:1", "msg_parent:2", "msg_child:1"]);
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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
    store.saveWorkflow("wf", "t", "digraph {}");
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

// Sub-agents are not runs — `enqueueConversation` and the
// `kind`/`parent_*` columns were removed in v7. The agent-tool seam
// is exercised in `packages/daemon/test/subagent.test.ts`.
