// Bundle import is a trust boundary (docs/SECURITY.md §4): a workflow must
// hash to its sha and its IR is re-derived from source; a bundle may never
// append into a run this store executes; a re-import of an imported run must
// extend its stored log as a prefix and leaves projection == replay.

import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import {
  BUNDLE_VERSION,
  canonicalJson,
  decodeJsonl,
  deriveRunState,
  encodeJsonl,
  ImportedRunError,
  newRunId,
  readTar,
  runEventsPath,
  sha256Hex,
  workflowIrPath,
  workflowSourcePath,
  writeTar,
} from "../src/index.ts";
import type { StoreCtx } from "../src/store-ctx.ts";
import { freshStore, hashedWorkflowSource, seedHashedWorkflow, storesOnOneFile } from "./helpers.ts";

const enc = new TextEncoder();

type Store = ReturnType<typeof freshStore>;

function replaceEntry(bytes: Uint8Array, name: string, data: string): Uint8Array {
  return writeTar(readTar(bytes).map((e) => (e.name === name ? { name, data: enc.encode(data) } : e)));
}

async function seedStartedRun(store: Store): Promise<{ runId: string; sha: string }> {
  const sha = await seedHashedWorkflow(store, "a");
  const runId = newRunId();
  store.enqueueRun({ runId, workflowSha: sha, cwd: "/home/dev/proj", initialRouting: { input: "seed" } });
  const v = store.getState(runId)!.version;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
      },
    ],
    v,
  );
  return { runId, sha };
}

function terminate(store: Store, runId: string): void {
  const v = store.getState(runId)!.version;
  store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "work" } }], v);
}

function exportBundle(store: Store, runId: string): Uint8Array {
  return store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" }).bytes;
}

type EventLine = { seq: number; type: string; writer: string; payload: unknown; ts: number };

function editEvents(bytes: Uint8Array, runId: string, edit: (events: EventLine[]) => EventLine[]): Uint8Array {
  const name = runEventsPath(runId);
  return writeTar(
    readTar(bytes).map((e) =>
      e.name === name ? { name, data: encodeJsonl(edit(decodeJsonl(e.data) as EventLine[])) } : e,
    ),
  );
}

describe("bundle import — workflow integrity (B2)", () => {
  test("rejects a bundle whose workflow source does not hash to its sha (B2)", async () => {
    const src = freshStore();
    const { runId, sha } = await seedStartedRun(src);
    const bytes = replaceEntry(exportBundle(src, runId), workflowSourcePath(sha), "PLANTED");
    src.close();

    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/source hashes to/);
    expect(dst.getWorkflow(sha)).toBeNull();
    expect(dst.getState(runId)).toBeNull();
    dst.close();
  });

  test("a planted source never replaces an existing genuine workflows row", async () => {
    const src = freshStore();
    const { runId, sha } = await seedStartedRun(src);
    const bytes = replaceEntry(exportBundle(src, runId), workflowSourcePath(sha), "PLANTED");
    src.close();

    const dst = freshStore();
    await seedHashedWorkflow(dst, "a");
    const before = dst.getWorkflow(sha)!;
    expect(() => dst.importRunBundle(bytes)).toThrow(/source hashes to/);
    const after = dst.getWorkflow(sha)!;
    expect(after.source).toBe(before.source);
    expect(after.ir).toBe(before.ir);
    dst.close();
  });

  test("rejects a bundle when an existing workflows row at that sha has different source", async () => {
    const src = freshStore();
    const { runId, sha } = await seedStartedRun(src);
    const bytes = exportBundle(src, runId);
    src.close();

    const dst = freshStore();
    const other = "name: other\nsteps:\n  work: {type: llm, prompt: y, next: exit}\n";
    dst.saveWorkflow(sha, "test", other, serializeGraph(parseWorkflow(other)), CURRENT_IR_VERSION);
    expect(() => dst.importRunBundle(bytes)).toThrow(/exists locally with different source/);
    expect(dst.getWorkflow(sha)!.source).toBe(other);
    expect(dst.getState(runId)).toBeNull();
    dst.close();
  });

  test("drops a planted ir.json and stores the IR re-derived from source", async () => {
    const src = freshStore();
    const { runId, sha } = await seedStartedRun(src);
    const bytes = replaceEntry(exportBundle(src, runId), workflowIrPath(sha), '{"planted":true}');
    src.close();

    const dst = freshStore();
    dst.importRunBundle(bytes);
    const row = dst.getWorkflow(sha)!;
    expect(row.ir).toBe(serializeGraph(parseWorkflow(hashedWorkflowSource("a"))));
    expect(row.irVersion).toBe(CURRENT_IR_VERSION);
    dst.close();
  });

  test("rejects a sha-consistent source that does not parse", () => {
    const bad = "this: is: not: a: workflow: {{{";
    const sha = sha256Hex(bad);
    const manifest = {
      bundleVersion: BUNDLE_VERSION,
      scrubberVersion: "1",
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [],
      workflows: [{ sha, name: "bad", irVersion: 1 }],
      blobs: [],
    };
    const bytes = writeTar([
      { name: "manifest.json", data: enc.encode(canonicalJson(manifest)) },
      { name: workflowSourcePath(sha), data: enc.encode(bad) },
      { name: workflowIrPath(sha), data: enc.encode("{}") },
    ]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/does not parse/);
    expect(dst.getWorkflow(sha)).toBeNull();
    dst.close();
  });
});

describe("bundle import — no append into a live run (C8)", () => {
  test("importing into a live, non-imported run throws and appends no events (C8)", async () => {
    const store = freshStore();
    const { runId } = await seedStartedRun(store);
    const bytes = editEvents(exportBundle(store, runId), runId, (events) => {
      const max = Math.max(...events.map((e) => e.seq));
      return [
        ...events,
        { seq: max + 1, type: "intent.cancel_requested", writer: "client", payload: { reason: "injected" }, ts: 1 },
      ];
    });
    const eventsBefore = store.getEvents(runId).length;
    const stateBefore = store.getState(runId)!;

    expect(() => store.importRunBundle(bytes)).toThrow(/exists locally and is not an imported run/);
    expect(store.getEvents(runId).length).toBe(eventsBefore);
    expect(store.getEvents(runId).some((e) => e.type === "intent.cancel_requested")).toBe(false);
    const stateAfter = store.getState(runId)!;
    expect(stateAfter.nextSeq).toBe(stateBefore.nextSeq);
    expect(stateAfter.version).toBe(stateBefore.version);
    expect(stateAfter.imported).toBe(false);
    store.close();
  });
});

describe("bundle import — re-import of an imported run (C1)", () => {
  async function twoBundles(): Promise<{ runId: string; b1: Uint8Array; b2: Uint8Array }> {
    const src = freshStore();
    const { runId } = await seedStartedRun(src);
    const b1 = exportBundle(src, runId);
    terminate(src, runId);
    const b2 = exportBundle(src, runId);
    src.close();
    return { runId, b1, b2 };
  }

  test("re-importing a strict extension yields projection == replay and next_seq == max(seq)+1 (C1)", async () => {
    const { runId, b1, b2 } = await twoBundles();
    const dst = freshStore();
    expect(dst.importRunBundle(b1).runs).toEqual([{ runId, imported: true }]);
    expect(dst.getState(runId)!.status).toBe("running");

    expect(dst.importRunBundle(b2).runs).toEqual([{ runId, imported: true }]);
    const events = dst.getEvents(runId);
    const replay = deriveRunState(runId, events);
    const state = dst.getState(runId)!;
    expect(state.status).toBe("completed");
    expect(state.status).toBe(replay.status);
    expect(state.version).toBe(replay.version);
    expect(state.lastAppliedSeq).toBe(replay.lastAppliedSeq);
    expect(state.currentNode).toBe(replay.currentNode);
    expect(state.routing).toEqual(replay.routing);
    expect(state.metrics).toEqual(replay.metrics);
    expect(state.nextSeq).toBe(Math.max(...events.map((e) => e.seq)) + 1);
    expect(state.imported).toBe(true);
    expect(state.cwd).toBeNull();
    dst.close();
  });

  test("re-importing an identical bundle stays a no-op", async () => {
    const { runId, b1 } = await twoBundles();
    const dst = freshStore();
    dst.importRunBundle(b1);
    const before = dst.getState(runId)!;
    const eventsBefore = dst.getEvents(runId).length;
    expect(dst.importRunBundle(b1).runs).toEqual([{ runId, imported: false }]);
    expect(dst.getEvents(runId).length).toBe(eventsBefore);
    expect(dst.getState(runId)!.version).toBe(before.version);
    dst.close();
  });

  test("appendIntent on an imported run throws ImportedRunError and writes nothing", async () => {
    const { runId, b1 } = await twoBundles();
    const dst = freshStore();
    dst.importRunBundle(b1);
    const before = dst.getState(runId)!;
    const eventsBefore = dst.getEvents(runId).length;

    expect(() => dst.appendIntent(runId, { type: "intent.cancel_requested", payload: {} })).toThrow(ImportedRunError);
    expect(dst.getState(runId)!.nextSeq).toBe(before.nextSeq);
    expect(dst.getEvents(runId).length).toBe(eventsBefore);
    dst.close();
  });

  test("re-importing an identical bundle after a refused intent is a no-op", async () => {
    const { runId, b1 } = await twoBundles();
    const dst = freshStore();
    dst.importRunBundle(b1);
    expect(() => dst.appendIntent(runId, { type: "intent.pause_requested", payload: {} })).toThrow(ImportedRunError);

    expect(dst.importRunBundle(b1).runs).toEqual([{ runId, imported: false }]);
    dst.close();
  });

  test("a non-prefix re-import throws and writes nothing", async () => {
    const { runId, b1, b2 } = await twoBundles();
    const forked = editEvents(b2, runId, (events) =>
      events.map((e) =>
        e.type === "fact.run_started"
          ? { ...e, payload: { ...(e.payload as Record<string, unknown>), startNode: "elsewhere" } }
          : e,
      ),
    );
    const dst = freshStore();
    dst.importRunBundle(b1);
    const before = dst.getState(runId)!;
    const eventsBefore = dst.getEvents(runId).length;

    expect(() => dst.importRunBundle(forked)).toThrow(/not a prefix/);
    expect(dst.getEvents(runId).length).toBe(eventsBefore);
    const after = dst.getState(runId)!;
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(after.nextSeq).toBe(before.nextSeq);
    dst.close();
  });
});

describe("bundle import — concurrent import (R3-C7)", () => {
  function beforeFirstWriteTxn(store: Store, hook: () => void): void {
    const ctx = (store as unknown as { ctx: StoreCtx }).ctx;
    const writeTxn = ctx.writeTxn.bind(ctx);
    let fired = false;
    (ctx as { writeTxn: StoreCtx["writeTxn"] }).writeTxn = (fn) => {
      if (!fired) {
        fired = true;
        hook();
      }
      writeTxn(fn);
    };
  }

  test("N stores importing one bundle concurrently: one insert, N−1 no-ops", async () => {
    const src = freshStore();
    const { runId } = await seedStartedRun(src);
    const bytes = exportBundle(src, runId);
    src.close();

    const rig = storesOnOneFile(3);
    try {
      const [a, b, c] = rig.stores as [Store, Store, Store];
      const results: { store: string; imported: boolean }[] = [];
      beforeFirstWriteTxn(b, () => {
        results.push({ store: "c", imported: c.importRunBundle(bytes).runs[0]!.imported });
      });
      beforeFirstWriteTxn(a, () => {
        results.push({ store: "b", imported: b.importRunBundle(bytes).runs[0]!.imported });
      });
      results.push({ store: "a", imported: a.importRunBundle(bytes).runs[0]!.imported });

      expect(results).toHaveLength(3);
      expect(results.filter((r) => r.imported)).toEqual([{ store: "c", imported: true }]);
      expect(results.filter((r) => !r.imported)).toHaveLength(2);
      const state = a.getState(runId)!;
      expect(state.imported).toBe(true);
      expect(state.version).toBe(deriveRunState(runId, a.getEvents(runId)).version);
    } finally {
      rig.dispose();
    }
  });

  test("an extension racing an extension re-classifies instead of throwing ConcurrencyError", async () => {
    const src = freshStore();
    const { runId } = await seedStartedRun(src);
    const b1 = exportBundle(src, runId);
    terminate(src, runId);
    const b2 = exportBundle(src, runId);
    src.close();

    const rig = storesOnOneFile(2);
    try {
      const [a, b] = rig.stores as [Store, Store];
      a.importRunBundle(b1);
      let bImported: boolean | undefined;
      beforeFirstWriteTxn(a, () => {
        bImported = b.importRunBundle(b2).runs[0]!.imported;
      });
      const aResult = a.importRunBundle(b2);

      expect(bImported).toBe(true);
      expect(aResult.runs).toEqual([{ runId, imported: false }]);
      const events = a.getEvents(runId);
      const replay = deriveRunState(runId, events);
      const state = a.getState(runId)!;
      expect(state.status).toBe("completed");
      expect(state.status).toBe(replay.status);
      expect(state.version).toBe(replay.version);
      expect(state.nextSeq).toBe(Math.max(...events.map((e) => e.seq)) + 1);
    } finally {
      rig.dispose();
    }
  });
});
