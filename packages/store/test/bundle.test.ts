// Run-bundle export (docs/proposals/db-import.md): the deterministic tar
// writer round-trips through the system `tar`, and `exportRunBundle` carries
// the portable run record while NEVER emitting the seeded credential —
// secret-free by construction, no scrub.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleManifest, canonicalJson, readTar, writeTar } from "../src/bundle.ts";
import { freshStore, seedRun } from "./helpers.ts";

function untar(bytes: Uint8Array, dir: string): void {
  const tarPath = join(dir, "bundle.tar");
  writeFileSync(tarPath, bytes);
  const r = Bun.spawnSync(["tar", "-xf", tarPath, "-C", dir]);
  if (r.exitCode !== 0) throw new Error(`tar extract failed: ${new TextDecoder().decode(r.stderr)}`);
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
  test("carries the portable run; never the seeded credential", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const SECRET = "sk-ant-test-DO-NOT-LEAK-0123456789abcdef";
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: SECRET }),
    });

    const bytes = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });

    // The secret bytes must not appear anywhere in the bundle.
    expect(Buffer.from(bytes).includes(SECRET)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "fragua-bundle-"));
    try {
      untar(bytes, dir);
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as BundleManifest;
      expect(manifest.bundleVersion).toBe(1);
      expect(manifest.fraguaVersion).toBe("0.0.0-test");
      expect(manifest.run.runId).toBe(runId);
      expect(manifest.events.length).toBeGreaterThan(0);
      expect(manifest.workflow.sha).toBe(manifest.run.workflowSha);
      // No provider/credential data rode along.
      expect(JSON.stringify(manifest)).not.toContain("sk-ant");
      expect(Object.keys(manifest)).not.toContain("providerCredentials");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    store.close();
  });
});

describe("importRunBundle", () => {
  test("round-trips a run into a fresh store; the credential never travels", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    src.setRunTitle(runId, "imported title");
    // An artifact (→ a blob) and a message, so import exercises the blob
    // integrity + replay paths, not just run_state + events.
    src.putArtifact({ runId, nodeId: "work", iteration: 0, key: "out" }, new TextEncoder().encode("artifact-bytes"));
    src.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      nodeId: "work",
      iteration: 0,
    });
    const SECRET = "sk-ant-test-DO-NOT-LEAK-0123456789abcdef";
    src.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: SECRET }),
    });
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    const srcEvents = src.getEvents(runId).length;

    // The blob bytes must physically travel inside the bundle: there's a
    // `blobs/<sha>` entry carrying the content.
    const blobEntry = readTar(bytes).find((e) => e.name.startsWith("blobs/"));
    expect(blobEntry).toBeDefined();
    expect(new TextDecoder().decode(blobEntry?.data ?? new Uint8Array())).toBe("artifact-bytes");

    // Close src FIRST — `:memory:` stores own a fresh temp blob dir that close()
    // destroys, so dst can't read the blob from a shared location. After this,
    // the tar `bytes` are the only possible carrier; a successful read on dst
    // proves the blob was rehydrated from the bundle, not aliased.
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runId).toBe(runId);
    expect(r.imported).toBe(true);
    expect(r.resumeCompatible).toBe(true);

    const state = dst.getState(runId);
    expect(state).not.toBeNull();
    expect(state?.title).toBe("imported title");
    expect(dst.getEvents(runId).length).toBe(srcEvents);
    expect(dst.getMessages(runId).length).toBe(1);
    // The blob survived and reads back through the artifact ref.
    const art = dst.getArtifact({ runId, nodeId: "work", iteration: 0, key: "out" });
    expect(new TextDecoder().decode(art)).toBe("artifact-bytes");
    // db-import §4: the source status travels VERBATIM (queued stays queued) —
    // no neutralization, show the original state. Local operator state is reset;
    // cwd unbound; the inbox is left empty (not local work to triage).
    expect(state?.status).toBe("queued");
    expect(state?.cwd).toBeNull();
    expect(state?.inboxStatus).toBeNull();
    expect(state?.acceptedSha).toBeNull();
    // Inertness is the imported_runs marker (§4.1), NOT the status: the run is
    // marked imported, and the queued claim skips it (the daemon won't dispatch it).
    expect(dst.isRunImported(runId)).toBe(true);
    expect(dst.claimNextRun(16)).toBeNull(); // the lone queued run is imported → not dispatched
    // The credential did NOT ride along — secret-free by construction.
    expect(dst.getProviderCredential("anthropic")).toBeNull();
    dst.close();
  });

  // §4.1: an imported run is inert (no dispatch / no capacity / no sweep / no
  // wake) but still VISIBLE (display counts include it) — the marker gates the
  // toward-execution paths, not the observational ones.
  test("an imported run is inert but visible — capacity, sweep, and wake all skip it", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    // Drive the source run to `running` so the bundle carries a non-terminal,
    // would-otherwise-dispatch status verbatim.
    expect(src.claimNextRun(16)).toEqual({ runId });
    expect(src.getState(runId)?.status).toBe("running");
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    expect(dst.importRunBundle(bytes).imported).toBe(true);
    expect(dst.getState(runId)?.status).toBe("running"); // verbatim
    expect(dst.isRunImported(runId)).toBe(true);

    // Visible: the display gauge counts the imported running run (§4.1 "counts is fine").
    expect(dst.runStateCounts().running).toBe(1);
    // Sweep: NOT requeued — its orphan-less running status is left exactly as-is.
    expect(dst.startupSweep().requeued).not.toContain(runId);
    expect(dst.getState(runId)?.status).toBe("running");
    // Wake: never a wake candidate, in any status set.
    const woke = dst.getWakeCandidates({
      statuses: ["running", "paused", "paused_human", "paused_auto", "quarantined"],
    });
    expect(woke.some((w) => w.runId === runId)).toBe(false);

    // Capacity: the imported running run does NOT consume a live slot. With a cap
    // of 1 and a native queued run present, the claim still goes through (it would
    // be blocked if the imported running run counted against the cap).
    const native = await seedRun(dst); // reuses the co-travelled workflow (saveWorkflow is idempotent)
    expect(dst.claimNextRun(1)).toEqual({ runId: native });
    dst.close();
  });

  // §4.1 C (adopt): clearing the marker un-parks the run — it rejoins dispatch
  // at its verbatim status. (The rehydration precondition is enforced by the CLI
  // `runs adopt` gate; here we cover the store primitive.)
  test("adopt clears the marker — the imported run rejoins dispatch", async () => {
    const src = freshStore();
    const runId = await seedRun(src); // queued
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    expect(dst.importRunBundle(bytes).imported).toBe(true);
    expect(dst.getState(runId)?.status).toBe("queued"); // verbatim
    // Parked: imported + not claimable by the dispatcher.
    expect(dst.isRunImported(runId)).toBe(true);
    expect(dst.claimNextRun(16)).toBeNull();

    // Adopt → un-parked; the queued run is now claimable.
    expect(dst.adoptRun(runId)).toBe(true);
    expect(dst.isRunImported(runId)).toBe(false);
    expect(dst.claimNextRun(16)).toEqual({ runId });
    // Idempotent: re-adopting is a no-op.
    expect(dst.adoptRun(runId)).toBe(false);
    dst.close();
  });

  test("is idempotent — re-importing the same bundle is a no-op", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    src.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      nodeId: "work",
      iteration: 0,
    });
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    expect(dst.importRunBundle(bytes).imported).toBe(true);
    const events = dst.getEvents(runId).length;
    const messages = dst.getMessages(runId).length;

    const second = dst.importRunBundle(bytes);
    expect(second.imported).toBe(false);
    expect(dst.getEvents(runId).length).toBe(events);
    expect(dst.getMessages(runId).length).toBe(messages);
    dst.close();
  });

  test("imports a too-new contractVersion but flags it resume-incompatible (inspect still works)", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    // Tamper the manifest's contract to a future version, re-tar.
    const entries = readTar(bytes);
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    manifest.contractVersion = 999;
    const tampered = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      ...entries.filter((e) => e.name.startsWith("blobs/")),
    ]);

    const dst = freshStore();
    const r = dst.importRunBundle(tampered);
    expect(r.imported).toBe(true);
    expect(r.resumeCompatible).toBe(false); // resume would park; inspect works now
    expect(dst.getState(runId)).not.toBeNull();
    dst.close();
  });

  test("rejects an unknown bundleVersion (fail-closed)", () => {
    const manifest = {
      bundleVersion: 999,
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      run: {},
      workflow: { sha: "x", name: "x", source: "x", ir: "x", irVersion: 1 },
      events: [],
      messages: [],
      artifacts: [],
      blobs: [],
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/bundleVersion/);
    dst.close();
  });

  test("rejects a blob whose bytes don't match its manifest sha (fail-closed)", () => {
    const manifest = {
      bundleVersion: 1,
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      run: {},
      workflow: { sha: "x", name: "x", source: "x", ir: "x", irVersion: 1 },
      events: [],
      messages: [],
      artifacts: [],
      blobs: [{ sha256: "deadbeef", size: 3 }],
    };
    const bytes = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      { name: "blobs/deadbeef", data: new TextEncoder().encode("xyz") },
    ]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/integrity/);
    dst.close();
  });

  test("rejects a bundle with no manifest", () => {
    const bytes = writeTar([{ name: "blobs/abc", data: new TextEncoder().encode("x") }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/manifest/);
    dst.close();
  });

  test("carries an optional git-bundle in its own entry; import validates + merges", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    const fakeBundle = new TextEncoder().encode("PACK-fake-git-bundle-bytes");
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x", gitBundle: fakeBundle });
    src.close();

    // The git-bundle rides a dedicated `git-bundle` entry + a manifest pointer —
    // NOT the content-addressed `blobs/` set.
    const entries = readTar(bytes);
    const gb = entries.find((e) => e.name === "git-bundle");
    expect(new TextDecoder().decode(gb?.data ?? new Uint8Array())).toBe("PACK-fake-git-bundle-bytes");
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    expect(manifest.gitBundle.size).toBe(fakeBundle.length);

    // Import validates its integrity and still merges the run (it's not a DB blob).
    const dst = freshStore();
    expect(dst.importRunBundle(bytes).runId).toBe(runId);
    expect(dst.getState(runId)).not.toBeNull();
    dst.close();
  });

  test("rejects a tampered git-bundle (fail-closed)", () => {
    const manifest = {
      bundleVersion: 1,
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      run: {},
      workflow: { sha: "x", name: "x", source: "x", ir: "x", irVersion: 1 },
      events: [],
      messages: [],
      artifacts: [],
      blobs: [],
      gitBundle: { sha256: "deadbeef", size: 3 },
    };
    const bytes = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      { name: "git-bundle", data: new TextEncoder().encode("xyz") },
    ]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/git-bundle/);
    dst.close();
  });

  // Security: the bundle-supplied runId flows into worktree paths + git refs on
  // rehydrate. A traversal-shaped id must be rejected before any of that.
  test("rejects a bundle whose runId could traverse paths/refs", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    const entries = readTar(bytes);
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    manifest.run.runId = "../../etc/evil";
    const tampered = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      ...entries.filter((e) => e.name.startsWith("blobs/")),
    ]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(tampered)).toThrow(/unsafe run id/);
    dst.close();
  });

  // Security: never merge into an existing run. Identical re-import is a no-op;
  // a bundle reusing the runId with divergent state is a hard error (not a splice).
  test("refuses a divergent collision; identical re-import is a no-op", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();

    const dst = freshStore();
    expect(dst.importRunBundle(bytes).imported).toBe(true);
    expect(dst.importRunBundle(bytes).imported).toBe(false); // identical → clean no-op

    const entries = readTar(bytes);
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    manifest.run.version = (manifest.run.version ?? 0) + 1; // same runId, divergent state
    const divergent = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      ...entries.filter((e) => e.name.startsWith("blobs/")),
    ]);
    expect(() => dst.importRunBundle(divergent)).toThrow(/divergent/);
    dst.close();
  });

  test("rejects a manifest that isn't valid JSON (fail-closed)", () => {
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode("{not json") }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/not valid JSON/);
    dst.close();
  });

  test("rejects a manifest missing a required array (fail-closed)", () => {
    const manifest = {
      bundleVersion: 1,
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      run: {},
      workflow: { sha: "x", name: "x", source: "x", ir: "x", irVersion: 1 },
      messages: [],
      artifacts: [],
      blobs: [], // events missing → shape check fails before any TypeError
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/events/);
    dst.close();
  });

  // Security: rows land under the bundle's own run, never the per-row runId — a
  // forged event/message naming another local run must not splice into it.
  test("does not splice forged events into another local run via per-row runId", async () => {
    const dst = freshStore();
    const victim = await seedRun(dst);
    const victimEvents = dst.getEvents(victim).length;

    const src = freshStore();
    const attacker = await seedRun(src);
    src.appendMessage(attacker, {
      content: { role: "user", content: [{ type: "text", text: "forged" }], timestamp: 1 },
      nodeId: "work",
      iteration: 0,
    });
    const bytes = src.exportRunBundle(attacker, { fraguaVersion: "x" });
    src.close();
    // Forge every event/message runId to point at the victim run.
    const entries = readTar(bytes);
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    for (const ev of manifest.events) ev.runId = victim;
    for (const m of manifest.messages) m.runId = victim;
    const forged = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      ...entries.filter((e) => e.name.startsWith("blobs/")),
    ]);

    expect(dst.importRunBundle(forged).runId).toBe(attacker); // imported under its OWN id
    expect(dst.getEvents(victim).length).toBe(victimEvents); // victim history untouched
    expect(dst.getEvents(attacker).length).toBeGreaterThan(0); // rows landed under the attacker run
    dst.close();
  });

  test("rejects a bundle whose nextSeq is behind its events (fail-closed)", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    const entries = readTar(bytes);
    const mEntry = entries.find((e) => e.name === "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(mEntry?.data ?? new Uint8Array()));
    manifest.run.nextSeq = 0; // behind the events it carries
    const tampered = writeTar([
      { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest)) },
      ...entries.filter((e) => e.name.startsWith("blobs/")),
    ]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(tampered)).toThrow(/nextSeq/);
    dst.close();
  });
});

describe("readTar", () => {
  test("rejects an entry whose name isn't null-terminated within 100 bytes", () => {
    const good = writeTar([{ name: "manifest.json", data: new TextEncoder().encode("{}") }]);
    const corrupt = new Uint8Array(good);
    for (let i = 0; i < 100; i++) corrupt[i] = 0x41; // 'A' — clobber the name field, no NUL
    expect(() => readTar(corrupt)).toThrow(/null-terminated/);
  });
});

describe("export determinism (db-import §6)", () => {
  test("canonicalJson sorts keys recursively — order-independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("re-export is store-independent and a fixpoint", async () => {
    const src = freshStore();
    const runId = await seedRun(src);
    src.putArtifact({ runId, nodeId: "work", iteration: 0, key: "out" }, new TextEncoder().encode("bytes"));
    src.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      nodeId: "work",
      iteration: 0,
    });
    const orig = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();

    // Two independent stores import the same bundle; their re-exports are
    // byte-identical (canonical manifest + ordered rows ⇒ store-independent).
    const a = freshStore();
    const b = freshStore();
    a.importRunBundle(orig);
    b.importRunBundle(orig);
    const ra = a.exportRunBundle(runId, { fraguaVersion: "x" });
    const rb = b.exportRunBundle(runId, { fraguaVersion: "x" });
    expect(Buffer.from(ra).equals(Buffer.from(rb))).toBe(true);

    // Re-export is a fixpoint: import a re-export, export again → identical bytes.
    const c = freshStore();
    c.importRunBundle(ra);
    const rc = c.exportRunBundle(runId, { fraguaVersion: "x" });
    expect(Buffer.from(rc).equals(Buffer.from(ra))).toBe(true);

    a.close();
    b.close();
    c.close();
  });
});
