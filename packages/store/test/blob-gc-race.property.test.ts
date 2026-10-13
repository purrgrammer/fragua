// Blob GC interleaved with writers in another process: random sequences of
// enqueue spills, output-struct spills, and artifact writes — each optionally
// with a GC sweep from a second store landing between its blob put() and its
// commit — mixed with planted orphan rows / files and plain sweeps. Values
// come from a tiny pool so writers keep deduping onto files GC is about to
// reap. After every step, every referenced blob must have both its row and
// its content.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { insertBlobIfAbsent, selectBlobRootShas } from "../src/artifact-queries.ts";
import type { BlobFS } from "../src/blob-fs.ts";
import { newRunId, type SqliteStore } from "../src/index.ts";
import { sha256Hex } from "../src/sha256.ts";
import { seedWorkflow, twoStoresOnOneFile } from "./helpers.ts";

const NOW = 1_700_000_000_000;
const enc = new TextEncoder();
const POOL = ["a", "b", "c"].map((c) => c.repeat(3200));

type Kind = "input" | "output" | "artifact";

function payloadOf(kind: Kind, v: number): Uint8Array {
  const value = POOL[v]!;
  return kind === "output" ? enc.encode(JSON.stringify({ report: value })) : enc.encode(value);
}

type Op =
  | { op: "write"; kind: Kind; v: number; raced: boolean }
  | { op: "orphanRow"; kind: Kind; v: number }
  | { op: "orphanFile"; kind: Kind; v: number }
  | { op: "gc" };

const kindArb = fc.constantFrom<Kind>("input", "output", "artifact");
const vArb = fc.integer({ min: 0, max: POOL.length - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("write" as const), kind: kindArb, v: vArb, raced: fc.boolean() }),
  fc.record({ op: fc.constant("orphanRow" as const), kind: kindArb, v: vArb }),
  fc.record({ op: fc.constant("orphanFile" as const), kind: kindArb, v: vArb }),
  fc.constant({ op: "gc" as const }),
);

const dbOf = (s: SqliteStore): Database => (s as unknown as { db: Database }).db;
const blobsOf = (s: SqliteStore): BlobFS => (s as unknown as { blobs: BlobFS }).blobs;

function withGcAfterFirstPut(writer: SqliteStore, gc: SqliteStore, fn: () => void): void {
  const blobs = blobsOf(writer);
  const put = blobs.put;
  let fired = false;
  blobs.put = (sha: string, content: Uint8Array): void => {
    put.call(blobs, sha, content);
    if (fired) return;
    fired = true;
    gc.gcBlobs();
  };
  try {
    fn();
  } finally {
    blobs.put = put;
  }
}

function write(store: SqliteStore, wfSha: string, artifactRunId: string, kind: Kind, v: number, key: string): void {
  if (kind === "input") {
    store.enqueueRun({ runId: newRunId(), workflowSha: wfSha, initialRouting: { inputs: { task: POOL[v]! } } });
    return;
  }
  if (kind === "artifact") {
    store.putArtifact({ runId: artifactRunId, nodeId: "n", iteration: 0, key }, payloadOf("artifact", v));
    return;
  }
  const runId = newRunId();
  store.enqueueRun({ runId, workflowSha: wfSha });
  const state = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      { type: "fact.run_started", payload: { workflowSha: wfSha, contractVersion: 1, startNode: "scope" } },
      {
        type: "fact.node_completed",
        payload: {
          nodeId: "scope",
          iteration: 0,
          tokens: 0,
          costUsd: 0,
          nextNode: "exit",
          outputs: { report: POOL[v]! },
        },
      },
    ],
    state.version,
  );
}

function referencedShas(store: SqliteStore): Set<string> {
  const db = dbOf(store);
  const out = selectBlobRootShas(db);
  for (const r of db.query<{ blob_sha: string }, []>("SELECT blob_sha FROM artifacts").all()) out.add(r.blob_sha);
  return out;
}

describe("blob GC under interleaved writers (property)", () => {
  test("no blob referenced by routing, outputs, or artifacts ever loses its row or file under interleaved enqueue / appendFact / gc", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 14 }), async (ops) => {
        const rig = twoStoresOnOneFile(NOW);
        try {
          const wfSha = await seedWorkflow(rig.a);
          const artifactRunId = newRunId();
          rig.a.enqueueRun({ runId: artifactRunId, workflowSha: wfSha });
          const root = (blobsOf(rig.a) as unknown as { root: string }).root;

          ops.forEach((o, i) => {
            if (o.op === "gc") {
              rig.b.gcBlobs();
            } else if (o.op === "write") {
              const run = () => write(rig.a, wfSha, artifactRunId, o.kind, o.v, `k${i}`);
              if (o.raced) withGcAfterFirstPut(rig.a, rig.b, run);
              else run();
            } else {
              const data = payloadOf(o.kind, o.v);
              const sha = sha256Hex(data);
              blobsOf(rig.a).put(sha, data);
              if (o.op === "orphanRow") {
                insertBlobIfAbsent(dbOf(rig.a), sha, data.length, 1);
              } else {
                const at = new Date(NOW - 10 * 60_000);
                utimesSync(join(root, sha.slice(0, 2), sha), at, at);
              }
            }

            for (const sha of referencedShas(rig.a)) {
              expect(dbOf(rig.a).query("SELECT 1 FROM blobs WHERE sha256 = ?").get(sha)).not.toBeNull();
              expect(rig.a.readBlob(sha)).not.toBeNull();
            }
          });
        } finally {
          rig.dispose();
        }
      }),
      { numRuns: pbtRuns(20) },
    );
  });
});
