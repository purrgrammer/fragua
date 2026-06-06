// Outputs index tests — insertOutput, getOutputsForRun, getLatestOutput,
// last-write-wins semantics, CASCADE delete, size cap, rebuild from facts.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { applyFact, emptyMetrics, SqliteStore } from "../src/index.ts";
import { getLatestOutput, getOutputsForRun, insertOutput } from "../src/outputs-queries.ts";
import { freshStore, seedRun, seedWorkflow } from "./helpers.ts";

function rawDb(store: SqliteStore): Database {
  return (store as unknown as { db: Database }).db;
}

describe("outputs index (direct SQL)", () => {
  test("insertOutput round-trips canonical JSON", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    const struct = { pr_number: "42", loc: 100 };
    insertOutput(db, runId, "scope", 0, JSON.stringify(struct));

    const rows = getOutputsForRun(db, runId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.struct)).toEqual(struct);
    expect(rows[0]!.nodeId).toBe("scope");
    expect(rows[0]!.iteration).toBe(0);
  });

  test("last-write-wins: re-inserting same (run, node, iteration) overwrites", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    insertOutput(db, runId, "scope", 0, JSON.stringify({ val: "first" }));
    insertOutput(db, runId, "scope", 0, JSON.stringify({ val: "second" }));

    const rows = getOutputsForRun(db, runId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.struct)).toEqual({ val: "second" });
  });

  test("multiple iterations are separate rows", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    insertOutput(db, runId, "scope", 0, JSON.stringify({ v: "iter0" }));
    insertOutput(db, runId, "scope", 1, JSON.stringify({ v: "iter1" }));

    const rows = getOutputsForRun(db, runId);
    expect(rows).toHaveLength(2);
  });

  test("getLatestOutput returns last-iteration struct", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    insertOutput(db, runId, "scope", 0, JSON.stringify({ v: "iter0" }));
    insertOutput(db, runId, "scope", 1, JSON.stringify({ v: "iter1" }));

    const latest = getLatestOutput(db, runId, "scope");
    expect(latest).not.toBeNull();
    expect(JSON.parse(latest!)).toEqual({ v: "iter1" });
  });

  test("getLatestOutput returns null for unknown node", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    expect(getLatestOutput(db, runId, "nonexistent")).toBeNull();
  });

  test("getOutputsForRun returns rows ordered by (nodeId ASC, iteration ASC)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    insertOutput(db, runId, "z_node", 0, JSON.stringify({ v: "z" }));
    insertOutput(db, runId, "a_node", 0, JSON.stringify({ v: "a" }));

    const rows = getOutputsForRun(db, runId);
    expect(rows[0]!.nodeId).toBe("a_node");
    expect(rows[1]!.nodeId).toBe("z_node");
  });

  test("rejects struct > 4096 bytes via SQL CHECK", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    const oversized = JSON.stringify({ data: "x".repeat(4100) });
    expect(() => insertOutput(db, runId, "scope", 0, oversized)).toThrow();
  });

  test("CASCADE delete: run deletion clears outputs rows", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = rawDb(store);

    insertOutput(db, runId, "scope", 0, JSON.stringify({ v: "1" }));
    expect(getOutputsForRun(db, runId)).toHaveLength(1);

    db.exec(`DELETE FROM run_state WHERE run_id = '${runId}'`);
    expect(getOutputsForRun(db, runId)).toHaveLength(0);
  });
});

describe("appendFact + outputs index (same-transaction write)", () => {
  function makeStore(): SqliteStore {
    return new SqliteStore({ path: ":memory:" });
  }

  async function makeStoreWithRun(): Promise<{ store: SqliteStore; runId: string; sha: string }> {
    const store = makeStore();
    const sha = await seedWorkflow(store);
    const runId = await seedRun(store, { workflowSha: sha });
    return { store, runId, sha };
  }

  test("fact.node_completed with outputs writes the outputs row", async () => {
    const { store, runId } = await makeStoreWithRun();

    // Start the run so version = 0 triggers a valid appendFact.
    const state = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "scope",
            iteration: 0,
            tokens: 10,
            costUsd: 0.001,
            nextNode: "exit",
            outputs: { pr_number: "99", loc: 200 },
          },
        },
      ],
      state.version,
    );

    const rows = store.getOutputsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.struct)).toEqual({ pr_number: "99", loc: 200 });
  });

  test("oversize outputs spill to the blob CAS and rehydrate on read", async () => {
    const { store, runId } = await makeStoreWithRun();
    const state = store.getState(runId)!;
    const big = "y".repeat(8000); // > 3 KiB inline budget → spills
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "scope",
            iteration: 0,
            tokens: 0,
            costUsd: 0,
            nextNode: "exit",
            outputs: { report: big, pr: "42" },
          },
        },
      ],
      state.version,
    );

    // Read rehydrates the full struct from the blob.
    const struct = JSON.parse(store.getOutputsForRun(runId)[0]!.struct);
    expect(struct.pr).toBe("42");
    expect(struct.report).toBe(big);
    // getLatestOutput rehydrates too.
    expect(JSON.parse(store.getLatestOutput(runId, "scope")!).report).toBe(big);

    // The event payload carries a tiny `$fragua_blob` ref, not the inline struct.
    const ev = store.getEvents(runId).find((e) => e.type === "fact.node_completed")!;
    const evOutputs = (ev.payload as { outputs: Record<string, unknown> }).outputs;
    expect(evOutputs["$fragua_blob"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev.payload).length).toBeLessThan(4096);

    // GC must NOT collect the spilled output blob (it's a root via the index).
    store.gcBlobs();
    expect(JSON.parse(store.getOutputsForRun(runId)[0]!.struct).report).toBe(big);
  });

  test("small outputs stay inline (no blob ref)", async () => {
    const { store, runId } = await makeStoreWithRun();
    const state = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: { nodeId: "scope", iteration: 0, tokens: 0, costUsd: 0, nextNode: "exit", outputs: { pr: "42" } },
        },
      ],
      state.version,
    );
    const ev = store.getEvents(runId).find((e) => e.type === "fact.node_completed")!;
    expect((ev.payload as { outputs: unknown }).outputs).toEqual({ pr: "42" });
  });

  test("fact.node_completed without outputs does not write to outputs table", async () => {
    const { store, runId } = await makeStoreWithRun();
    const state = store.getState(runId)!;

    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: { nodeId: "scope", iteration: 0, tokens: 5, costUsd: 0.0005, nextNode: "exit" },
        },
      ],
      state.version,
    );

    const rows = store.getOutputsForRun(runId);
    expect(rows).toHaveLength(0);
  });
});

describe("reducer purity for outputs (no-bump invariant)", () => {
  test("applyFact ignores payload.outputs on fact.node_completed", async () => {
    const baseState = {
      runId: "r1",
      version: 0,
      status: "running" as const,
      currentNode: "scope",
      workflowSha: "sha",
      contractVersion: 1,
      routing: {},
      metrics: emptyMetrics(),
      nextSeq: 1,
      lastAppliedSeq: 0,
      priority: 0,
      enqueuedAt: 0,
      readyAt: 0,
      nodeStartedAt: null,
      dispatchStartedAt: null,
      updatedAt: 0,
      title: null,
      baseGitSha: null,
      baseGitRef: null,
      finalGitSha: null,
      finalHeadRef: null,
      diffBaseSha: null,
      changeStat: null,
      inboxStatus: null,
      acceptedSha: null,
      cwd: null,
      projectId: "proj",
      projectName: "Test",
      workflowName: null,
      workflowScope: null,
      workflowPath: null,
      scheduleId: null,
    };

    const factWithOutputs = {
      type: "fact.node_completed" as const,
      payload: {
        nodeId: "scope",
        iteration: 0,
        tokens: 10,
        costUsd: 0.001,
        nextNode: "merge",
        outputs: { pr_number: "99" },
      },
    };
    const factWithoutOutputs = {
      type: "fact.node_completed" as const,
      payload: {
        nodeId: "scope",
        iteration: 0,
        tokens: 10,
        costUsd: 0.001,
        nextNode: "merge",
      },
    };

    const stateWith = applyFact(baseState, factWithOutputs, 1000);
    const stateWithout = applyFact(baseState, factWithoutOutputs, 1000);

    // Both results must be identical (outputs is not folded into run_state).
    expect(stateWith.currentNode).toBe(stateWithout.currentNode);
    expect(stateWith.metrics.billedTokens).toBe(stateWithout.metrics.billedTokens);
    expect(stateWith.metrics.totalCostUsd).toBe(stateWithout.metrics.totalCostUsd);
    // Verify run_state itself has no "outputs" field (pure re-snapshot).
    expect((stateWith as unknown as Record<string, unknown>)["outputs"]).toBeUndefined();
  });

  test("EVENT_CONTRACT_VERSION is still 1 (no fold-contract bump needed)", async () => {
    const { EVENT_CONTRACT_VERSION } = require("../src/pragmas.ts") as { EVENT_CONTRACT_VERSION: number };
    expect(EVENT_CONTRACT_VERSION).toBe(1);
  });
});
