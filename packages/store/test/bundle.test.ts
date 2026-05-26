// Bundle export/import (docs/proposals/bundles.md): the deterministic tar
// round-trips through the system `tar`; `exportRunBundle` carries the run's raw
// event log + transcript + blobs and NEVER the seeded credential; import
// re-DERIVES `run_state` by replaying the log (no projection in the bundle), so
// an imported run reconstructs faithfully and is inert (cwd null).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleManifest, canonicalJson, type FactEvent, newRunId, readTar, writeTar } from "../src/index.ts";
import { freshStore, seedWorkflow } from "./helpers.ts";

function untar(bytes: Uint8Array, dir: string): void {
  const tarPath = join(dir, "bundle.tar");
  writeFileSync(tarPath, bytes);
  const r = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir]);
  if (r.exitCode !== 0) throw new Error(`tar extract failed: ${new TextDecoder().decode(r.stderr)}`);
}

/** Enqueue (with cwd, so the import-drops-cwd invariant is observable), then
 *  drive a terminal run: started → snapshot → completed + a message + artifact. */
async function seedTerminalRun(store: ReturnType<typeof freshStore>): Promise<string> {
  const sha = await seedWorkflow(store);
  const runId = newRunId();
  store.enqueueRun({
    runId,
    workflowSha: sha,
    priority: 3,
    cwd: "/home/dev/proj",
    projectId: "proj-id",
    projectName: "proj",
    workflowName: "wf",
    workflowScope: "local",
    initialRouting: { input: "seed input" },
  });
  store.putArtifact({ runId, nodeId: "work", iteration: 0, key: "out" }, new TextEncoder().encode("artifact-bytes"));
  store.appendMessage(runId, {
    content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    nodeId: "work",
    iteration: 0,
  });
  let v = store.getState(runId)!.version;
  const started: FactEvent = {
    type: "fact.run_started",
    payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
  };
  v = store.appendFact(runId, [started], v).newVersion;
  store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);
  return runId;
}

describe("writeTar", () => {
  test("produces an archive the system tar extracts faithfully", () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-tar-"));
    try {
      const enc = new TextEncoder();
      const bytes = writeTar([
        { name: "manifest.json", data: enc.encode('{"hi":1}') },
        { name: "blobs/abc123", data: enc.encode("blob-content-here") },
      ]);
      untar(bytes, dir);
      expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe('{"hi":1}');
      expect(readFileSync(join(dir, "blobs", "abc123"), "utf8")).toBe("blob-content-here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is deterministic — same inputs, byte-identical output", () => {
    const d = new TextEncoder().encode("payload");
    const a = writeTar([{ name: "manifest.json", data: d }]);
    const b = writeTar([{ name: "manifest.json", data: d }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("exportRunBundle", () => {
  test("carries the event log + workflow + blobs; no run_state; never the credential", async () => {
    const store = freshStore();
    const runId = await seedTerminalRun(store);
    const SECRET = "sk-ant-test-DO-NOT-LEAK-0123456789abcdef";
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: SECRET }),
    });

    const bytes = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    expect(Buffer.from(bytes).includes(SECRET)).toBe(false);

    const entries = readTar(bytes);
    const names = entries.map((e) => e.name);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;

    expect(manifest.bundleVersion).toBe(1);
    expect(manifest.fraguaVersion).toBe("0.0.0-test");
    // Index-only manifest — no serialized projection.
    expect(manifest).not.toHaveProperty("run");
    expect(manifest.runs).toEqual([
      { runId, workflowSha: manifest.workflows[0]!.sha, events: expect.any(Number), messages: 1 },
    ]);
    expect(names).toContain(`runs/${runId}/events.jsonl`);
    expect(names).toContain(`runs/${runId}/messages.jsonl`);
    expect(names).toContain(`workflows/${manifest.workflows[0]!.sha}/source.yaml`);
    expect(names.some((n) => n.startsWith("blobs/"))).toBe(true);
    // The artifact blob bytes physically travel.
    const blob = entries.find((e) => e.name.startsWith("blobs/"));
    expect(new TextDecoder().decode(blob!.data)).toBe("artifact-bytes");
    store.close();
  });
});

describe("importRunBundle", () => {
  test("round-trips a run by DERIVING run_state; credential never travels; cwd dropped", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    src.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: "sk-ant-secret" }),
    });
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    const srcState = src.getState(runId)!;
    const srcEvents = src.getEvents(runId).length;
    // Close src first: `:memory:` owns a temp blob dir close() destroys, so a
    // successful read on dst proves the blob came from the bundle, not an alias.
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runs).toEqual([{ runId, imported: true }]);
    expect(r.resumeCompatible).toBe(true);

    const state = dst.getState(runId)!;
    expect(state).not.toBeNull();
    // Derived projection matches the source's — modulo write bookkeeping, the
    // out-of-band title, and the deliberately-dropped local cwd binding.
    expect(state.status).toBe("completed");
    expect(state.projectId).toBe("proj-id");
    expect(state.routing).toEqual({ input: "seed input" });
    expect(state.baseGitSha).toBe("base");
    expect(state.cwd).toBeNull(); // src had a cwd; import drops it → inert
    expect(srcState.cwd).toBe("/home/dev/proj");

    expect(dst.getEvents(runId).length).toBe(srcEvents);
    expect(dst.getMessages(runId).length).toBe(1);
    const art = dst.getArtifact({ runId, nodeId: "work", iteration: 0, key: "out" });
    expect(new TextDecoder().decode(art)).toBe("artifact-bytes");
    // The credential did not travel.
    expect(dst.getProviderCredential("anthropic")).toBeNull();
    dst.close();
  });

  test("an imported run is inert — never claimed, even when it derives to queued", async () => {
    // A bundle of a NOT-yet-started source run derives to status `queued` with a
    // null cwd. The marker — not the null cwd — is what holds it out of dispatch.
    const src = freshStore();
    const sha = await seedWorkflow(src);
    const runId = newRunId();
    src.enqueueRun({ runId, workflowSha: sha, cwd: "/somewhere", initialRouting: { input: "x" } });
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();

    const dst = freshStore();
    dst.importRunBundle(bytes);
    expect(dst.getState(runId)?.status).toBe("queued"); // derived, non-terminal
    // The daemon must never claim it — the inert marker excludes it from the
    // queued selection (a native queued run WOULD be claimed).
    expect(dst.claimNextRun(10)).toBeNull();
    dst.close();
  });

  test("idempotent — re-import is a no-op", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();

    const dst = freshStore();
    expect(dst.importRunBundle(bytes).runs).toEqual([{ runId, imported: true }]);
    const events1 = dst.getEvents(runId).length;
    const r2 = dst.importRunBundle(bytes);
    expect(r2.runs).toEqual([{ runId, imported: false }]);
    expect(dst.getEvents(runId).length).toBe(events1);
    dst.close();
  });

  test("fails closed on an unsupported bundleVersion", () => {
    const manifest = {
      bundleVersion: 999,
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [],
      workflows: [],
      blobs: [],
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(canonicalJson(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/unsupported bundleVersion/);
    dst.close();
  });

  test("fails closed on a blob integrity mismatch", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    // Rebuild the tar with the blob entry's bytes tampered — its sha won't match.
    const entries = readTar(bytes).map((e) =>
      e.name.startsWith("blobs/") ? { name: e.name, data: new TextEncoder().encode("TAMPERED") } : e,
    );
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(entries))).toThrow(/integrity check/);
    dst.close();
  });
});
