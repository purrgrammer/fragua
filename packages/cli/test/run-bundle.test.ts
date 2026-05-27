// `fragua runs export` / `fragua import` command layer. The store-level
// round-trip + fail-closed paths live in @fragua/store's bundle.test.ts; here we
// cover the CLI wiring: export of a real run, import into an EXISTING store
// (import is a migrate:false store-client — it never creates/migrates), and the
// error paths (missing run, absent target store, missing bundle).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, newRunId, SqliteStore, writeTar } from "@fragua/store";
import { exportCommand, importCommand } from "../src/commands/run-bundle.ts";
import { showCommand } from "../src/commands/show.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });
const dirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fragua-runbundle-"));
  dirs.push(d);
  return d;
}

/** Create a real file-backed store at `<dir>/store.db`, seed a run with an
 *  artifact (→ a blob in `<dir>/blobs`), and return its path + run id. */
function seedStore(dir: string): { dbPath: string; runId: string } {
  const dbPath = join(dir, "store.db");
  const store = new SqliteStore({ path: dbPath });
  const sha = "a".repeat(64); // realistic content-hash sha — import shape-gates it
  store.saveWorkflow(sha, "test", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
  const runId = newRunId();
  store.enqueueRun({ runId, workflowSha: sha, priority: 0 });
  store.putArtifact({ runId, nodeId: "work", iteration: 0, key: "out" }, new TextEncoder().encode("hello-bytes"));
  store.close();
  return { dbPath, runId };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("fragua runs export / import", () => {
  test("export → import round-trips a run (+ its blob) into an existing store", async () => {
    const { dbPath: srcDb, runId } = seedStore(freshDir());
    const dstDir = freshDir();
    const dstDb = join(dstDir, "store.db");
    const bundle = join(dstDir, "r.fragua");
    // The target must already exist — import never creates a store.
    new SqliteStore({ path: dstDb }).close();

    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);
    expect(await importCommand({ bundle, dbPath: dstDb })).toBe(0);

    // src + dst have separate blobs dirs, so a readable artifact on dst proves
    // the blob travelled inside the bundle.
    const dst = new SqliteStore({ path: dstDb, migrate: false });
    try {
      expect(dst.getState(runId)).not.toBeNull();
      expect(dst.getState(runId)?.cwd).toBeNull(); // imported runs are inert
      const art = dst.getArtifact({ runId, nodeId: "work", iteration: 0, key: "out" });
      expect(new TextDecoder().decode(art)).toBe("hello-bytes");
    } finally {
      dst.close();
    }
  });

  test("import into an absent store errors (no implicit create/migrate)", async () => {
    const { dbPath: srcDb, runId } = seedStore(freshDir());
    const dstDir = freshDir();
    const bundle = join(dstDir, "r.fragua");
    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);
    // The target db does not exist → migrate:false open fails → exit 1.
    expect(await importCommand({ bundle, dbPath: join(dstDir, "absent.db") })).toBe(1);
  });

  test("export of a missing run errors", async () => {
    const { dbPath: srcDb } = seedStore(freshDir());
    expect(await exportCommand({ runId: "run_nope", to: join(freshDir(), "x.fragua"), dbPath: srcDb })).toBe(1);
  });

  test("import of a missing bundle errors", async () => {
    const { dbPath } = seedStore(freshDir());
    expect(await importCommand({ bundle: join(freshDir(), "nope.fragua"), dbPath })).toBe(1);
  });
});

describe("fragua show", () => {
  test("validates + summarizes a real bundle (exit 0)", async () => {
    const { dbPath: srcDb, runId } = seedStore(freshDir());
    const bundle = join(freshDir(), "r.fragua");
    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);
    expect(await showCommand({ bundle })).toBe(0);
  });

  test("errors on a missing bundle (exit 1)", async () => {
    expect(await showCommand({ bundle: join(freshDir(), "nope.fragua") })).toBe(1);
  });

  test("fails closed (exit 1) when a manifest run is missing its events.jsonl", async () => {
    // A manifest declaring a run with no runs/<id>/events.jsonl — import would
    // reject it, so `show` (the preflight) must not exit 0.
    const manifest = {
      bundleVersion: 2,
      scrubberVersion: "1",
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [{ runId: newRunId(), workflowSha: "a".repeat(64), events: 0, messages: 0 }],
      workflows: [],
      blobs: [],
    };
    const bundle = join(freshDir(), "broken.fragua");
    writeFileSync(
      bundle,
      writeTar([{ name: "manifest.json", data: new TextEncoder().encode(canonicalJson(manifest)) }]),
    );
    expect(await showCommand({ bundle })).toBe(1);
  });
});
