// The run_state projection write carries its own OCC guard: the UPDATE
// only matches WHERE version = expectedVersion. appendFact's pre-check
// validates the version earlier in the same transaction, but that holds
// the invariant by convention — these tests pin the structural guard, so
// a projection write racing a version bump throws instead of silently
// overwriting the projection with stale state.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ConcurrencyError, type RunState } from "../src/index.ts";
import { migrate } from "../src/migrations.ts";
import { insertRunState, selectRunStateRow, writeRunStateProjection } from "../src/run-state-queries.ts";
import { freshStore, seedRun } from "./helpers.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  migrate(db);
  db.query(
    "INSERT INTO workflows (sha, name, source, ir, ir_version, created_at) VALUES ('wf', 't', 's', '{}', 1, 0)",
  ).run();
  return db;
}

function seedRawRun(db: Database, runId: string): void {
  insertRunState(db, {
    runId,
    workflowSha: "wf",
    contractVersion: 1,
    routing: "{}",
    metrics: "{}",
    priority: 0,
    enqueuedAt: 1000,
    readyAt: 1000,
    updatedAt: 1000,
    cwd: "/repos/proj",
    projectId: "p1",
    projectName: "proj",
    workflowName: "wf",
    workflowScope: "local",
    workflowPath: null,
    scheduleId: null,
  });
}

function projectionArgs(runId: string, version: number, expectedVersion: number) {
  return {
    runId,
    version,
    expectedVersion,
    status: "running" as const,
    currentNode: "work",
    routingJson: "{}",
    metricsJson: "{}",
    lastAppliedSeq: 1,
    priority: 0,
    readyAt: 1000,
    nodeStartedAt: 2000,
    dispatchStartedAt: null,
    updatedAt: 2000,
    baseGitSha: null,
    baseGitRef: null,
    finalGitSha: null,
    finalHeadRef: null,
    diffBaseSha: null,
    changeStatJson: null,
    inboxStatus: null,
    acceptedSha: null,
  };
}

describe("writeRunStateProjection — OCC guard", () => {
  test("matching expected version applies the write and returns true", () => {
    const db = freshDb();
    seedRawRun(db, "r1");

    const applied = writeRunStateProjection(db, projectionArgs("r1", 2, 1));
    expect(applied).toBe(true);

    const row = selectRunStateRow(db, "r1")!;
    expect(row.version).toBe(2);
    expect(row.status).toBe("running");
    expect(row.current_node).toBe("work");
    db.close();
  });

  test("stale expected version matches zero rows and leaves the projection untouched", () => {
    const db = freshDb();
    seedRawRun(db, "r1");

    // Row is at version 1; a writer holding a stale snapshot expects 7.
    const applied = writeRunStateProjection(db, projectionArgs("r1", 8, 7));
    expect(applied).toBe(false);

    const row = selectRunStateRow(db, "r1")!;
    expect(row.version).toBe(1);
    expect(row.status).toBe("queued");
    expect(row.current_node).toBeNull();
    db.close();
  });

  test("unknown run matches zero rows", () => {
    const db = freshDb();
    expect(writeRunStateProjection(db, projectionArgs("ghost", 2, 1))).toBe(false);
    db.close();
  });
});

describe("SqliteStore — projection write throws on stale expected version", () => {
  test("writeProjection with a stale expected version throws ConcurrencyError, projection unchanged", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const state = store.getState(runId)!;

    // Reach the private write path directly: appendFact's pre-check would
    // normally catch the stale version first, so this exercises the
    // structural guard that backs it (defense in depth).
    const writeProjection = (
      store as unknown as { writeProjection(state: RunState, expectedVersion: number): void }
    ).writeProjection.bind(store);

    const doomed: RunState = { ...state, version: state.version + 6, status: "running", currentNode: "work" };
    expect(() => writeProjection(doomed, state.version + 5)).toThrow(ConcurrencyError);

    const after = store.getState(runId)!;
    expect(after.version).toBe(state.version);
    expect(after.status).toBe("queued");
    expect(after.currentNode).toBeNull();

    store.close();
  });

  test("appendFact pre-check still fires first on a stale expectedVersion", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const state = store.getState(runId)!;
    const fact = {
      type: "fact.run_started" as const,
      payload: {
        workflowSha: state.workflowSha,
        contractVersion: state.contractVersion,
        startNode: "work",
      },
    };
    store.appendFact(runId, [fact], state.version);
    expect(() => store.appendFact(runId, [fact], state.version)).toThrow(ConcurrencyError);

    // The successful append landed through the guarded projection write.
    expect(store.getState(runId)!.version).toBe(state.version + 1);
    store.close();
  });
});
