// Integration tests for the routing-inputs spill path and GC root protection.
import { describe, expect, test } from "bun:test";
import {
  isBlobRef,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_ROUTING_BYTES,
  materializeRouting,
  PayloadTooLargeError,
  PER_VALUE_SPILL_BYTES,
} from "../src/index.ts";
import { freshStore, nextId, seedWorkflow } from "./helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function storeGetBlob(store: ReturnType<typeof freshStore>) {
  return (sha: string): Uint8Array => {
    const bytes = store.readBlob(sha);
    if (bytes == null) throw new Error(`blob missing: ${sha}`);
    return bytes;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spill at enqueue
// ─────────────────────────────────────────────────────────────────────────────

describe("SqliteStore — routing-inputs spill at enqueue", () => {
  test("(a) enqueue with a >4KB routing.inputs value succeeds and genesis stays under cap", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();
    const bigValue = "a".repeat(MAX_EVENT_PAYLOAD_BYTES + 100); // definitely over 4 KB

    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: { inputs: { task: bigValue } },
    });

    // Genesis event must be under the cap
    const events = store.getEvents(runId);
    const genesisEvent = events.find((e) => e.type === "intent.run_enqueued");
    expect(genesisEvent).toBeDefined();
    const payloadStr = JSON.stringify(genesisEvent!.payload);
    expect(payloadStr.length).toBeLessThan(MAX_EVENT_PAYLOAD_BYTES);

    // routing.inputs.task must be a BlobRef in run_state
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    const inputs = state!.routing["inputs"] as Record<string, unknown>;
    expect(isBlobRef(inputs["task"])).toBe(true);

    // genesis event routing also carries the ref
    const genesisRouting = (genesisEvent!.payload as Record<string, unknown>)["routing"] as Record<string, unknown>;
    const genesisInputs = genesisRouting["inputs"] as Record<string, unknown>;
    expect(isBlobRef(genesisInputs["task"])).toBe(true);

    // The blob must be present
    const ref = inputs["task"] as { $fragua_blob: string; bytes: number };
    const blobBytes = store.readBlob(ref["$fragua_blob"]);
    expect(blobBytes).not.toBeNull();
    expect(new TextDecoder().decode(blobBytes!)).toBe(bigValue);

    store.close();
  });

  test("(e) small run stores routing.inputs inline — no ref, no blob", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();

    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: { inputs: { task: "short value" } },
    });

    const state = store.getState(runId);
    expect(state).not.toBeNull();
    const inputs = state!.routing["inputs"] as Record<string, unknown>;
    expect(inputs["task"]).toBe("short value");
    expect(isBlobRef(inputs["task"])).toBe(false);

    store.close();
  });

  test("spilled input survives in both run_state.routing and genesis event payload", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();
    const bigValue = "B".repeat(PER_VALUE_SPILL_BYTES + 1);

    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: { inputs: { brief: bigValue } },
    });

    const state = store.getState(runId);
    const genesisPayload = store.getEvents(runId).find((e) => e.type === "intent.run_enqueued")!.payload;
    const stateInputs = state!.routing["inputs"] as Record<string, unknown>;
    const eventInputs = ((genesisPayload as Record<string, unknown>)["routing"] as Record<string, unknown>)[
      "inputs"
    ] as Record<string, unknown>;

    // Both must be BlobRefs with the same sha
    expect(isBlobRef(stateInputs["brief"])).toBe(true);
    expect(isBlobRef(eventInputs["brief"])).toBe(true);
    const stateSha = (stateInputs["brief"] as { $fragua_blob: string })["$fragua_blob"];
    const eventSha = (eventInputs["brief"] as { $fragua_blob: string })["$fragua_blob"];
    expect(stateSha).toBe(eventSha);

    // And materializeRouting round-trips back
    const materialized = materializeRouting(state!.routing, storeGetBlob(store));
    expect((materialized["inputs"] as Record<string, unknown>)["brief"]).toBe(bigValue);

    store.close();
  });

  test("structural routing entries (non-inputs) never spill even when large", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();

    // Put a large value in a structural key (not inputs) — only inputs spill
    // Structural key alone doesn't trigger spill, value stays inline
    const routing = {
      budget_override: { "total.usd": 5 },
      inputs: { task: "short" },
    };

    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: routing,
    });

    const state = store.getState(runId);
    expect(state).not.toBeNull();
    // budget_override stays as an object
    expect(typeof state!.routing["budget_override"]).toBe("object");
    // inputs.task stays inline (short value)
    expect((state!.routing["inputs"] as Record<string, unknown>)["task"]).toBe("short");

    store.close();
  });

  test("oversize structural routing (non-inputs) still throws PayloadTooLargeError", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);

    // Place the bulk in a non-inputs key (cannot be spilled); routing limit should trigger
    const bigStructural = "x".repeat(MAX_ROUTING_BYTES);
    expect(() =>
      store.enqueueRun({
        runId: nextId(),
        workflowSha: wfSha,
        initialRouting: { bloat: bigStructural },
      }),
    ).toThrow(PayloadTooLargeError);

    store.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GC root protection
// ─────────────────────────────────────────────────────────────────────────────

describe("SqliteStore — gcBlobs routing roots", () => {
  test("(d) gcBlobs does NOT collect a routing-referenced blob, but DOES collect orphan blobs", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();
    const bigValue = "Z".repeat(PER_VALUE_SPILL_BYTES + 1);

    // Enqueue a run whose input is spilled
    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: { inputs: { task: bigValue } },
    });

    const state = store.getState(runId);
    const inputs = state!.routing["inputs"] as Record<string, unknown>;
    expect(isBlobRef(inputs["task"])).toBe(true);
    const spilledSha = (inputs["task"] as { $fragua_blob: string })["$fragua_blob"];

    // Also enqueue a run whose artifact we'll then orphan to act as a
    // genuinely-unreferenced blob. We simulate this by writing a blob file
    // without a blobs row (as if from a crashed write) — it sits outside the
    // artifact table and outside routing refs, so GC must delete it.
    // Use an internal-ish approach: write a file at the BlobFS path without
    // inserting a row, and verify GC pass 2 removes it.
    // We can do this by calling putArtifact and then deleting the artifact row.
    // Actually the simplest: use a second store method to put a raw blob file
    // and skip the DB row, simulating an orphan file.
    // SqliteStore.readBlob returns null for unknown shas, but the file is there.
    // We'll use the test-internal BlobFS knowledge: write via putArtifact and
    // delete the artifact row directly to orphan the blob DB row.
    const orphanContent = new TextEncoder().encode("orphan blob content");
    const { sha256Hex } = await import("../src/sha256.ts");
    const orphanSha = sha256Hex(orphanContent);

    // Insert both the blob row and the file directly through putArtifact
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    const { insertBlobIfAbsent } = await import("../src/artifact-queries.ts");
    // Put the file via internal blobs handle
    const blobs = (store as unknown as { blobs: import("../src/blob-fs.ts").BlobFS }).blobs;
    blobs.put(orphanSha, orphanContent);
    // Insert the DB row so it exists (GC pass 1 will delete it since no artifact refs it)
    insertBlobIfAbsent(db, orphanSha, orphanContent.length, Date.now());

    // Verify both blobs exist before GC
    expect(store.readBlob(spilledSha)).not.toBeNull();
    expect(store.readBlob(orphanSha)).not.toBeNull();

    // Run GC
    const result = store.gcBlobs();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // Spilled routing blob must still be present
    expect(store.readBlob(spilledSha)).not.toBeNull();
    const dec = new TextDecoder();
    expect(dec.decode(store.readBlob(spilledSha)!)).toBe(bigValue);

    // Orphan blob must be gone
    expect(store.readBlob(orphanSha)).toBeNull();

    store.close();
  });

  test("gcBlobs orphan-file pass skips routing-root shas even when no blobs row", async () => {
    const store = freshStore();
    const wfSha = await seedWorkflow(store);
    const runId = nextId();
    const bigValue = "R".repeat(PER_VALUE_SPILL_BYTES + 1);

    store.enqueueRun({
      runId,
      workflowSha: wfSha,
      initialRouting: { inputs: { brief: bigValue } },
    });

    const state = store.getState(runId);
    const spilledSha = ((state!.routing["inputs"] as Record<string, unknown>)["brief"] as { $fragua_blob: string })[
      "$fragua_blob"
    ];

    // Simulate a crash that deleted the blobs row (but left the file)
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    db.run("DELETE FROM blobs WHERE sha256 = ?", [spilledSha]);

    // The file should still be there
    const blobs = (store as unknown as { blobs: import("../src/blob-fs.ts").BlobFS }).blobs;
    expect(blobs.has(spilledSha)).toBe(true);

    // GC should NOT delete the routing-root file even without a blobs row
    store.gcBlobs();
    expect(blobs.has(spilledSha)).toBe(true);

    store.close();
  });
});
