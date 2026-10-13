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
import { insertOutput } from "../src/outputs-queries.ts";
import { freshStore, seedRun } from "./helpers.ts";

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
