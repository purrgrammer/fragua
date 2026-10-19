// Blob GC roots are resolved inside the orphan DELETE statement, so a blob a
// run's routing or an outputs row points at is protected by the same snapshot
// the delete runs under — there is no scan-then-delete window for a concurrent
// spill to fall into. These pin the SQL directly: a sha reachable only through
// nested routing, one reachable only through an outputs-index ref, and a true
// orphan.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  deleteOrphanBlobs,
  insertBlobIfAbsent,
  selectBlobRootShas,
  selectDeletableOrphanFiles,
} from "../src/artifact-queries.ts";
import { insertEventDaemon } from "../src/event-queries.ts";
import { newRunId } from "../src/index.ts";
import { insertOutput } from "../src/outputs-queries.ts";
import { bumpRunSeq } from "../src/run-state-queries.ts";
import { sha256Hex } from "../src/sha256.ts";
import { freshStore, seedHashedWorkflow, seedRun } from "./helpers.ts";

const ROUTED = "a".repeat(64);
const EMITTED = "b".repeat(64);
const ORPHAN = "c".repeat(64);
const ROWED = "d".repeat(64);
const BARE = "e".repeat(64);

describe("blob GC roots", () => {
  test("routing refs (nested) and outputs refs survive; the orphan is returned", async () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database }).db;
    const runId = await seedRun(store);
    for (const sha of [ROUTED, EMITTED, ORPHAN]) insertBlobIfAbsent(db, sha, 1, 1);

    db.query("UPDATE run_state SET routing = ? WHERE run_id = ?").run(
      JSON.stringify({ inputs: { cfg: { docs: [{ $fragua_blob: ROUTED, bytes: 2048 }] } } }),
      runId,
    );
    insertOutput(db, runId, "scope", 0, JSON.stringify({ $fragua_blob: EMITTED, bytes: 9000 }));

    expect(selectBlobRootShas(db)).toEqual(new Set([ROUTED, EMITTED]));
    expect(deleteOrphanBlobs(db, 1000)).toEqual([ORPHAN]);
    const remaining = db
      .query<{ sha256: string }, []>("SELECT sha256 FROM blobs ORDER BY sha256")
      .all()
      .map((r) => r.sha256);
    expect(remaining).toEqual([ROUTED, EMITTED]);
    store.close();
  });

  test("selectDeletableOrphanFiles returns only candidates with neither a row nor a root", async () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database }).db;
    const runId = await seedRun(store);
    insertBlobIfAbsent(db, ROWED, 1, 1);
    db.query("UPDATE run_state SET routing = ? WHERE run_id = ?").run(
      JSON.stringify({ inputs: { brief: { $fragua_blob: ROUTED, bytes: 2048 } } }),
      runId,
    );
    insertOutput(db, runId, "scope", 0, JSON.stringify({ $fragua_blob: EMITTED, bytes: 9000 }));

    expect(selectDeletableOrphanFiles(db, JSON.stringify([ROUTED, EMITTED, ROWED, BARE]))).toEqual([BARE]);
    expect(selectDeletableOrphanFiles(db, "[]")).toEqual([]);
    store.close();
  });

  test("a fact.node_completed outputs ref stays a root after its outputs row is replaced, and export succeeds (C3)", async () => {
    const store = freshStore();
    const sha = await seedHashedWorkflow(store, "gc-roots");
    const runId = newRunId();
    store.enqueueRun({ runId, workflowSha: sha, cwd: "/home/dev/p" });
    const first = { report: "1".repeat(5000) };
    const second = { report: "2".repeat(5000) };
    const firstSha = sha256Hex(new TextEncoder().encode(JSON.stringify(first)));
    const secondSha = sha256Hex(new TextEncoder().encode(JSON.stringify(second)));
    let v = store.getState(runId)!.version;
    v = store.appendFact(
      runId,
      [{ type: "fact.run_started", payload: { workflowSha: sha, contractVersion: 1, startNode: "scope" } }],
      v,
    ).newVersion;
    for (const outputs of [first, second]) {
      v = store.appendFact(
        runId,
        [
          {
            type: "fact.node_completed",
            payload: { nodeId: "scope", iteration: 0, tokens: 0, costUsd: 0, nextNode: "scope", outputs },
          },
        ],
        v,
      ).newVersion;
    }
    store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "scope" } }], v);

    expect(store.getOutputsForRun(runId)).toHaveLength(1);
    expect(store.gcBlobs().deleted).toBe(0);
    expect(store.readBlob(firstSha)).not.toBeNull();
    expect(store.readBlob(secondSha)).not.toBeNull();
    expect(() => store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" })).not.toThrow();
    store.close();
  });

  test("only fact.node_completed payloads root a blob through events.outputs_blob_sha", async () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database }).db;
    const runId = await seedRun(store);
    const ref = JSON.stringify({ nodeId: "scope", iteration: 0, outputs: { $fragua_blob: EMITTED, bytes: 9000 } });
    const other = JSON.stringify({ nodeId: "scope", outputs: { $fragua_blob: ORPHAN, bytes: 9000 } });
    insertEventDaemon(db, runId, bumpRunSeq(db, runId), "fact.node_completed", ref, 1);
    insertEventDaemon(db, runId, bumpRunSeq(db, runId), "llm.done", other, 1);

    const roots = selectBlobRootShas(db);
    expect(roots.has(EMITTED)).toBe(true);
    expect(roots.has(ORPHAN)).toBe(false);
    store.close();
  });

  test("a routing row that is not valid JSON neither aborts the sweep nor protects anything", async () => {
    const store = freshStore();
    const db = (store as unknown as { db: Database }).db;
    const runId = await seedRun(store);
    insertBlobIfAbsent(db, ORPHAN, 1, 1);
    db.query("UPDATE run_state SET routing = ? WHERE run_id = ?").run("{not json", runId);
    expect(deleteOrphanBlobs(db, 1000)).toEqual([ORPHAN]);
    store.close();
  });
});
