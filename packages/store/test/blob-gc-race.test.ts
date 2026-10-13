// Blob GC racing a writer in another process. Every writer puts its blob file
// before the transaction that commits the row, and BlobFS.put() is a no-op
// when the file already exists — so a put() that dedupes onto an old orphan
// file can be undercut by a GC that deletes that file before the writer's row
// commits. These force each interleaving on two stores sharing one DB file and
// one blob directory: GC must decide + delete under its write lock, and the
// writer must re-put after its commit.

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { insertBlobIfAbsent } from "../src/artifact-queries.ts";
import type { BlobFS } from "../src/blob-fs.ts";
import { newRunId, type SqliteStore } from "../src/index.ts";
import { sha256Hex } from "../src/sha256.ts";
import type { StoreCtx } from "../src/store-ctx.ts";
import { freshStore, seedRun, seedWorkflow, twoStoresOnOneFile } from "./helpers.ts";

const NOW = 1_700_000_000_000;
const enc = new TextEncoder();

function dbOf(store: SqliteStore): Database {
  return (store as unknown as { db: Database }).db;
}

function blobsOf(store: SqliteStore): BlobFS {
  return (store as unknown as { blobs: BlobFS }).blobs;
}

function ctxOf(store: SqliteStore): StoreCtx {
  return (store as unknown as { ctx: StoreCtx }).ctx;
}

function blobRow(store: SqliteStore, sha: string): boolean {
  return dbOf(store).query("SELECT 1 FROM blobs WHERE sha256 = ?").get(sha) != null;
}

function plantOrphan(store: SqliteStore, data: Uint8Array, opts: { row: boolean }): string {
  const sha = sha256Hex(data);
  blobsOf(store).put(sha, data);
  if (opts.row) insertBlobIfAbsent(dbOf(store), sha, data.length, 1);
  return sha;
}

function backdate(store: SqliteStore, sha: string, atMs: number): void {
  const root = (blobsOf(store) as unknown as { root: string }).root;
  utimesSync(join(root, sha.slice(0, 2), sha), new Date(atMs), new Date(atMs));
}

/** Run `hook` once, right after the first put() on `store` returns — i.e.
 * after the writer's pre-transaction blob write, before its commit. */
function afterFirstPut(store: SqliteStore, hook: () => void): void {
  const blobs = blobsOf(store);
  const put = blobs.put.bind(blobs);
  let fired = false;
  blobs.put = (sha: string, content: Uint8Array): void => {
    put(sha, content);
    if (fired) return;
    fired = true;
    hook();
  };
}

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe("gcBlobs racing a concurrent writer", () => {
  test("a routing spill whose put deduped onto an orphan file survives a GC that runs before the enqueue commits", async () => {
    const rig = twoStoresOnOneFile(NOW);
    dispose = rig.dispose;
    const wfSha = await seedWorkflow(rig.a);
    const value = "Z".repeat(2000);
    const sha = plantOrphan(rig.a, enc.encode(value), { row: true });

    let gcDeleted = 0;
    afterFirstPut(rig.a, () => {
      gcDeleted = rig.b.gcBlobs().deleted;
    });
    const runId = newRunId();
    rig.a.enqueueRun({ runId, workflowSha: wfSha, initialRouting: { inputs: { task: value } } });

    expect(gcDeleted).toBe(1);
    const inputs = rig.a.getState(runId)!.routing["inputs"] as Record<string, { $fragua_blob: string }>;
    expect(inputs["task"]!.$fragua_blob).toBe(sha);
    expect(new TextDecoder().decode(rig.a.readBlob(sha)!)).toBe(value);
    expect(blobRow(rig.a, sha)).toBe(true);
  });

  test("an output-struct spill whose put deduped onto an orphan file survives a GC that runs before appendFact commits", async () => {
    const rig = twoStoresOnOneFile(NOW);
    dispose = rig.dispose;
    const runId = await seedRun(rig.a);
    const outputs = { report: "y".repeat(8000), pr: "42" };
    const sha = plantOrphan(rig.a, enc.encode(JSON.stringify(outputs)), { row: true });

    let gcDeleted = 0;
    afterFirstPut(rig.a, () => {
      gcDeleted = rig.b.gcBlobs().deleted;
    });
    const state = rig.a.getState(runId)!;
    rig.a.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: { nodeId: "scope", iteration: 0, tokens: 0, costUsd: 0, nextNode: "exit", outputs },
        },
      ],
      state.version,
    );

    expect(gcDeleted).toBe(1);
    const rows = rig.a.getOutputsForRun(runId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.struct).report).toBe(outputs.report);
    expect(blobRow(rig.a, sha)).toBe(true);
  });

  test("pass 2 re-checks rows and roots under the write lock after listing files", async () => {
    const rig = twoStoresOnOneFile(NOW);
    dispose = rig.dispose;
    const wfSha = await seedWorkflow(rig.a);
    const value = "Q".repeat(2000);
    const sha = plantOrphan(rig.a, enc.encode(value), { row: false });
    backdate(rig.a, sha, NOW - 10 * 60_000);

    // Land the enqueue after GC's directory walk + pre-filter, right before it
    // takes the lock for the file-delete transaction (pass 1 is call #1).
    const ctx = ctxOf(rig.b);
    const writeTxn = ctx.writeTxn.bind(ctx);
    let calls = 0;
    const runId = newRunId();
    (ctx as { writeTxn: StoreCtx["writeTxn"] }).writeTxn = (fn) => {
      calls++;
      if (calls === 2) rig.a.enqueueRun({ runId, workflowSha: wfSha, initialRouting: { inputs: { task: value } } });
      writeTxn(fn);
    };

    const { deleted } = rig.b.gcBlobs();

    expect(calls).toBe(2);
    expect(deleted).toBe(0);
    expect(blobsOf(rig.a).has(sha)).toBe(true);
    expect(new TextDecoder().decode(rig.a.readBlob(sha)!)).toBe(value);
  });

  test("a failing post-commit re-put does not hide a committed appendFact's result", async () => {
    const store = freshStore(NOW);
    const runId = await seedRun(store);
    const outputs = { report: "r".repeat(8000) };

    const blobs = blobsOf(store);
    const put = blobs.put.bind(blobs);
    let calls = 0;
    blobs.put = (sha: string, content: Uint8Array): void => {
      calls++;
      if (calls > 1) throw new Error("disk full");
      put(sha, content);
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const state = store.getState(runId)!;
    const result = store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, contractVersion: 1, startNode: "scope" },
        },
        {
          type: "fact.node_completed",
          payload: { nodeId: "scope", iteration: 0, tokens: 0, costUsd: 0, nextNode: "exit", outputs },
        },
      ],
      state.version,
    );
    const warnings = warn.mock.calls.length;
    warn.mockRestore();

    expect(calls).toBe(2);
    expect(warnings).toBe(1);
    expect(result.committed).toBe(true);
    expect(result.newVersion).toBe(state.version + 1);
    expect(store.getState(runId)!.version).toBe(state.version + 1);
    expect(JSON.parse(store.getOutputsForRun(runId)[0]!.struct).report).toBe(outputs.report);
    store.close();
  });

  test("GC deletes orphan files inside its write transaction", async () => {
    const store = freshStore(NOW);
    await seedRun(store);
    plantOrphan(store, enc.encode("row orphan"), { row: true });
    const fileOnly = plantOrphan(store, enc.encode("file orphan"), { row: false });
    backdate(store, fileOnly, NOW - 10 * 60_000);

    const blobs = blobsOf(store);
    const del = blobs.delete.bind(blobs);
    const inTxn: boolean[] = [];
    blobs.delete = (sha: string): void => {
      inTxn.push(dbOf(store).inTransaction);
      del(sha);
    };

    expect(store.gcBlobs().deleted).toBe(2);
    expect(inTxn).toEqual([true, true]);
    store.close();
  });
});
