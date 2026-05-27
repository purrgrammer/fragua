// Bundle export/import (docs/proposals/archive/bundles.md): the deterministic tar
// round-trips through the system `tar`; `exportRunBundle` carries a FILTERED event
// log (fact.* + intent.* + cost.recorded only - observability dropped) + transcript
// + blobs and NEVER the seeded credential; import re-DERIVES `run_state` by
// replaying the log (no projection in the bundle), so an imported run reconstructs
// faithfully and is inert (cwd null).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_VERSION,
  type BundleManifest,
  canonicalJson,
  type FactEvent,
  type IntentEvent,
  isBlobRef,
  materializeRouting,
  newRunId,
  readTar,
  SCRUBBER_VERSION,
  writeTar,
} from "../src/index.ts";
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
  // A realistic content-hash workflow sha - import shape-gates it as a sha256.
  const sha = await seedWorkflow(store, "a".repeat(64));
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

  test("is deterministic - same inputs, byte-identical output", () => {
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

    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    expect(Buffer.from(bytes).includes(SECRET)).toBe(false);

    const entries = readTar(bytes);
    const names = entries.map((e) => e.name);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;

    expect(manifest.bundleVersion).toBe(BUNDLE_VERSION);
    expect(manifest.fraguaVersion).toBe("0.0.0-test");
    // Index-only manifest - no serialized projection.
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
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
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
    // Derived projection matches the source's - modulo write bookkeeping, the
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

  test("an imported run is inert - never claimed, even when it derives to queued", async () => {
    // A bundle of a NOT-yet-started source run derives to status `queued` with a
    // null cwd. The marker - not the null cwd - is what holds it out of dispatch.
    const src = freshStore();
    const sha = await seedWorkflow(src, "a".repeat(64));
    const runId = newRunId();
    src.enqueueRun({ runId, workflowSha: sha, cwd: "/somewhere", initialRouting: { input: "x" } });
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();

    const dst = freshStore();
    dst.importRunBundle(bytes);
    expect(dst.getState(runId)?.status).toBe("queued"); // derived, non-terminal
    // The daemon must never claim it - the inert marker excludes it from the
    // queued selection (a native queued run WOULD be claimed).
    expect(dst.claimNextRun(10)).toBeNull();
    dst.close();
  });

  test("idempotent - re-import is a no-op", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
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
      scrubberVersion: "1",
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

  test("rejects a workflow id that isn't a sha256 (shape gate on a path/SQL key)", () => {
    const manifest = {
      bundleVersion: BUNDLE_VERSION,
      scrubberVersion: "1",
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [],
      workflows: [{ sha: "not-a-sha", name: "n", irVersion: 1 }],
      blobs: [],
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(canonicalJson(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/sha256/);
    dst.close();
  });

  test("rejects a workflow name over the cap (reject, not silent clamp)", () => {
    const manifest = {
      bundleVersion: BUNDLE_VERSION,
      scrubberVersion: "1",
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [],
      workflows: [{ sha: "a".repeat(64), name: "x".repeat(513), irVersion: 1 }],
      blobs: [],
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(canonicalJson(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/exceeds \d+ chars/);
    dst.close();
  });

  test("rejects a non-numeric workflow irVersion (every SQL-bound field is gated)", () => {
    const manifest = {
      bundleVersion: BUNDLE_VERSION,
      scrubberVersion: "1",
      fraguaVersion: "x",
      contractVersion: 1,
      schemaVersion: 1,
      irVersion: 1,
      runs: [],
      workflows: [{ sha: "a".repeat(64), name: "n", irVersion: "1" }],
      blobs: [],
    };
    const bytes = writeTar([{ name: "manifest.json", data: new TextEncoder().encode(canonicalJson(manifest)) }]);
    const dst = freshStore();
    expect(() => dst.importRunBundle(bytes)).toThrow(/irVersion/);
    dst.close();
  });

  // Tamper the genesis event's payload and assert the gate rejects it. `mutate`
  // edits the parsed payload; `expectThrow` is the message the gate should emit.
  async function genesisTamperRejects(mutate: (payload: Record<string, unknown>) => unknown, expectThrow: RegExp) {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    const entries = readTar(bytes);
    const evName = `runs/${runId}/events.jsonl`;
    const tampered = entries.map((e) => {
      if (e.name !== evName) return e;
      const lines = new TextDecoder().decode(e.data).trim().split("\n");
      const i = lines.findIndex((l) => l.includes("intent.run_enqueued"));
      const ev = JSON.parse(lines[i]!);
      ev.payload = mutate(ev.payload) ?? ev.payload;
      lines[i] = JSON.stringify(ev);
      return { name: e.name, data: new TextEncoder().encode(`${lines.join("\n")}\n`) };
    });
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(tampered))).toThrow(expectThrow);
    dst.close();
  }

  test("rejects a wrong-typed genesis workflowSha (not just non-null)", async () => {
    await genesisTamperRejects((p) => {
      p["workflowSha"] = 12345;
    }, /sha256/);
  });

  test("rejects an array genesis payload (typeof [] === 'object' must not slip)", async () => {
    await genesisTamperRejects(() => [1, 2, 3], /genesis payload is not an object/);
  });

  test("rejects an array genesis routing", async () => {
    await genesisTamperRejects((p) => {
      p["routing"] = [];
    }, /genesis routing is not an object/);
  });

  test("rejects a tampered messages.jsonl row (non-numeric ordinal)", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    const entries = readTar(bytes);
    const msgName = `runs/${runId}/messages.jsonl`;
    const tampered = entries.map((e) => {
      if (e.name !== msgName) return e;
      const lines = new TextDecoder().decode(e.data).trim().split("\n");
      const m = JSON.parse(lines[0]!);
      m.ordinal = "1"; // string, not number - non-null, slips a bare sweep
      lines[0] = JSON.stringify(m);
      return { name: e.name, data: new TextEncoder().encode(`${lines.join("\n")}\n`) };
    });
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(tampered))).toThrow(/non-numeric ordinal/);
    dst.close();
  });

  test("rejects a duplicate runId in the manifest", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    // Duplicate the single run entry in the manifest.
    const entries = readTar(bytes);
    const mani = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data));
    mani.runs.push({ ...mani.runs[0] });
    const tampered = entries.map((e) =>
      e.name === "manifest.json" ? { name: e.name, data: new TextEncoder().encode(canonicalJson(mani)) } : e,
    );
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(tampered))).toThrow(/duplicate runId/);
    dst.close();
  });

  test("rejects an event with an invalid writer", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    const entries = readTar(bytes);
    const evName = `runs/${runId}/events.jsonl`;
    const tampered = entries.map((e) => {
      if (e.name !== evName) return e;
      const lines = new TextDecoder().decode(e.data).trim().split("\n");
      const first = JSON.parse(lines[0]!);
      first.writer = "attacker";
      lines[0] = JSON.stringify(first);
      return { name: e.name, data: new TextEncoder().encode(`${lines.join("\n")}\n`) };
    });
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(tampered))).toThrow(/invalid writer/);
    dst.close();
  });

  test("fails closed on a blob integrity mismatch", async () => {
    const src = freshStore();
    const runId = await seedTerminalRun(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "x" });
    src.close();
    // Rebuild the tar with the blob entry's bytes tampered - its sha won't match.
    const entries = readTar(bytes).map((e) =>
      e.name.startsWith("blobs/") ? { name: e.name, data: new TextEncoder().encode("TAMPERED") } : e,
    );
    const dst = freshStore();
    expect(() => dst.importRunBundle(writeTar(entries))).toThrow(/integrity check/);
    dst.close();
  });
});

describe("exportRunBundle - observability event filtering", () => {
  /** Seed a terminal run and append several observability events of different
   * families, plus a cost.recorded event, before exporting. */
  async function seedWithObservability(store: ReturnType<typeof freshStore>): Promise<string> {
    const runId = await seedTerminalRun(store);
    store.appendObservabilityEvents(runId, [
      { type: "llm.text_delta", payload: { delta: "secret token here" } },
      { type: "agent.turn_start", payload: { nodeId: "work", iteration: 0 } },
      { type: "tool.execution_start", payload: { name: "bash", nodeId: "work" } },
      { type: "summary.text_delta", payload: { delta: "summarised thread content" } },
      { type: "control.pause_requested", payload: { reason: "human" } },
      { type: "steering.message_sent", payload: { text: "steer text" } },
      { type: "run.title_generated", payload: { title: "My secret run" } },
      { type: "budget.warning", payload: { threshold: 0.8 } },
      { type: "cost.recorded", payload: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 } },
    ]);
    return runId;
  }

  function extractEventTypes(bytes: Uint8Array, runId: string): string[] {
    const entries = readTar(bytes);
    const evEntry = entries.find((e) => e.name === `runs/${runId}/events.jsonl`);
    if (evEntry == null) return [];
    return new TextDecoder()
      .decode(evEntry.data)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { type: string }).type);
  }

  test("(a) content-bearing observability families are absent from the exported events.jsonl", async () => {
    const store = freshStore();
    const runId = await seedWithObservability(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const types = extractEventTypes(bytes, runId);
    const droppedPrefixes = ["llm.", "agent.", "tool.execution", "summary.", "control.", "steering.", "budget."];
    const droppedLiterals = ["run.title_generated"];
    for (const prefix of droppedPrefixes) {
      const leaked = types.filter((t) => t.startsWith(prefix));
      expect(leaked).toEqual([]);
    }
    for (const lit of droppedLiterals) {
      expect(types).not.toContain(lit);
    }
  });

  test("(b) cost.recorded survives the filter", async () => {
    const store = freshStore();
    const runId = await seedWithObservability(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const types = extractEventTypes(bytes, runId);
    expect(types).toContain("cost.recorded");
  });

  test("(c) fact.* events survive and importRunBundle derives status=completed", async () => {
    const src = freshStore();
    const runId = await seedWithObservability(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const types = extractEventTypes(bytes, runId);
    expect(types.some((t) => t.startsWith("fact."))).toBe(true);

    const dst = freshStore();
    dst.importRunBundle(bytes);
    expect(dst.getState(runId)?.status).toBe("completed");
    dst.close();
  });

  test("(d) genesis intent.run_enqueued survives so import works", async () => {
    const store = freshStore();
    const runId = await seedWithObservability(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const types = extractEventTypes(bytes, runId);
    expect(types).toContain("intent.run_enqueued");
  });

  test("stored events are not mutated - getEvents still returns all families", async () => {
    const store = freshStore();
    const runId = await seedWithObservability(store);
    const allStored = store.getEvents(runId).map((e) => e.type);
    store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    const allAfter = store.getEvents(runId).map((e) => e.type);
    expect(allAfter).toEqual(allStored);
    expect(allStored).toContain("llm.text_delta");
    store.close();
  });

  test("manifest events count reflects filtered count, not total stored", async () => {
    const store = freshStore();
    const runId = await seedWithObservability(store);
    const totalStored = store.getEvents(runId).length;
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;
    const exportedCount = manifest.runs[0]!.events;
    expect(exportedCount).toBeLessThan(totalStored);

    const types = extractEventTypes(bytes, runId);
    expect(types.length).toBe(exportedCount);
  });
});

describe("exportRunBundle - message transcript scrubbing", () => {
  const CWD = "/home/dev/proj";
  const CRED_SECRET = "sk-ant-test-secretABCDEFGHIJ0123456789";
  const AKIA_SECRET = "AKIAIOSFODNN7EXAMPLE";

  /** Seed a run whose single message contains all three secret varieties. */
  async function seedRunWithSecrets(store: ReturnType<typeof freshStore>): Promise<string> {
    const sha = await seedWorkflow(store, "a".repeat(64));
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      priority: 3,
      cwd: CWD,
      projectId: "proj-id",
      projectName: "proj",
      workflowName: "wf",
      workflowScope: "local",
      initialRouting: { input: "seed" },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    store.appendMessage(runId, {
      content: {
        role: "user" as const,
        content: [
          {
            type: "text",
            text: `cred=${CRED_SECRET} akia=${AKIA_SECRET} path=${CWD}`,
          },
        ],
        timestamp: 1,
      },
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

  function extractFirstMessageContent(bytes: Uint8Array, runId: string): unknown {
    const entries = readTar(bytes);
    const msgEntry = entries.find((e) => e.name === `runs/${runId}/messages.jsonl`);
    if (msgEntry == null) return null;
    const line = new TextDecoder().decode(msgEntry.data).trim().split("\n")[0]!;
    return (JSON.parse(line) as { content: unknown }).content;
  }

  test("(a) redacts literal provider-credential value from message content", async () => {
    const store = freshStore();
    const runId = await seedRunWithSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    expect(Buffer.from(bytes).includes(CRED_SECRET)).toBe(false);
    const content = JSON.stringify(extractFirstMessageContent(bytes, runId));
    expect(content).toContain("[REDACTED:provider_creds]");
  });

  test("(b) redacts AKIA pattern-shaped secret from message content", async () => {
    const store = freshStore();
    const runId = await seedRunWithSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    expect(Buffer.from(bytes).includes(AKIA_SECRET)).toBe(false);
    const content = JSON.stringify(extractFirstMessageContent(bytes, runId));
    expect(content).toContain("[REDACTED:pattern:aws_access_key_id]");
  });

  test("(c) redacts cwd path from message content; event payloads stay raw", async () => {
    const store = freshStore();
    const runId = await seedRunWithSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    // cwd must be absent from the bundle bytes (scrubbed from message content).
    expect(Buffer.from(bytes).includes(CWD)).toBe(false);
    const content = JSON.stringify(extractFirstMessageContent(bytes, runId));
    expect(content).toContain("[REDACTED:cwd]");

    // Event payloads are NOT scrubbed in this unit - fact payload strings (e.g.
    // workflowSha, nodeId in fact.run_completed) survive verbatim.
    const entries = readTar(bytes);
    const evEntry = entries.find((e) => e.name === `runs/${runId}/events.jsonl`);
    const evText = new TextDecoder().decode(evEntry!.data);
    // fact.run_completed.finalNode="work" is a structural string in the event log
    // that must not be redacted (even though "work" also appears as nodeId in messages).
    expect(evText).toContain('"finalNode":"work"');
    // The AKIA key embedded in message content does NOT appear in events.
    expect(evText).not.toContain(AKIA_SECRET);
  });

  test("(d) scrubJsonStrings recurses into nested content arrays", async () => {
    const sha = await seedWorkflow(freshStore(), "a".repeat(64));
    const store = freshStore();
    const sha2 = await seedWorkflow(store, "a".repeat(64));
    void sha;
    void sha2;
    // Build a store with a deeply-nested tool_result message.
    const store2 = freshStore();
    const sha3 = await seedWorkflow(store2, "a".repeat(64));
    const runId = newRunId();
    store2.enqueueRun({
      runId,
      workflowSha: sha3,
      cwd: CWD,
      initialRouting: { input: "seed" },
    });
    store2.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    store2.appendMessage(runId, {
      content: {
        role: "user" as const,
        content: [
          { type: "text", text: `outer: ok` },
          { type: "text", text: `nested secret: ${CRED_SECRET}` },
        ],
        timestamp: 1,
      },
      nodeId: "work",
      iteration: 0,
    });
    let v = store2.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha3, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store2.appendFact(runId, [started], v).newVersion;
    store2.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    const { bytes } = store2.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store2.close();

    expect(Buffer.from(bytes).includes(CRED_SECRET)).toBe(false);
    const content = JSON.stringify(extractFirstMessageContent(bytes, runId));
    expect(content).toContain("[REDACTED:provider_creds]");
  });

  test("(e) nodeId and iteration are not scrubbed (only content is deep-walked)", async () => {
    const store = freshStore();
    const runId = await seedRunWithSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const msgEntry = entries.find((e) => e.name === `runs/${runId}/messages.jsonl`);
    const line = new TextDecoder().decode(msgEntry!.data).trim().split("\n")[0]!;
    const row = JSON.parse(line) as { nodeId: string; iteration: number };
    expect(row.nodeId).toBe("work");
    expect(row.iteration).toBe(0);
  });

  test("(f) manifest carries bundleVersion 2 and scrubberVersion '1'", async () => {
    const store = freshStore();
    const runId = await seedRunWithSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;
    expect(manifest.bundleVersion).toBe(BUNDLE_VERSION);
    expect(manifest.bundleVersion).toBe(2);
    expect(manifest.scrubberVersion).toBe(SCRUBBER_VERSION);
    expect(manifest.scrubberVersion).toBe("1");
  });

  test("(g) importRunBundle round-trips a scrubbed run - status derives, messages present but redacted", async () => {
    const src = freshStore();
    const runId = await seedRunWithSecrets(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runs).toEqual([{ runId, imported: true }]);

    const state = dst.getState(runId)!;
    expect(state.status).toBe("completed");

    const msgs = dst.getMessages(runId);
    expect(msgs.length).toBe(1);
    const msgText = JSON.stringify(msgs[0]!.content);
    expect(msgText).toContain("[REDACTED:");
    expect(msgText).not.toContain(CRED_SECRET);
    expect(msgText).not.toContain(AKIA_SECRET);
    dst.close();
  });
});

describe("exportRunBundle - event payload scrubbing (surfaces 5-6)", () => {
  const CWD = "/home/dev/proj";
  const CRED_SECRET = "sk-ant-evt-secretABCDEFGHIJ0123456789";
  const AKIA_SECRET = "AKIAIOSFODNN7EXAMPLE";

  /** Seed a run with events carrying secrets in every targeted surface. */
  async function seedRunWithEventSecrets(store: ReturnType<typeof freshStore>): Promise<string> {
    const sha = await seedWorkflow(store, "b".repeat(64));
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      priority: 3,
      cwd: CWD,
      projectId: "proj-id",
      projectName: "proj",
      workflowName: "wf",
      workflowScope: "local",
      // routing.inputs values carry secrets - surface 6. Include a stale
      // routing.input key to verify the scrubber handles arbitrary routing keys.
      initialRouting: { input: `run with secret ${CRED_SECRET}`, inputs: { apiKey: AKIA_SECRET } },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });

    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;

    // fact.tool_completed.preview — surface 5.
    v = store.appendFact(
      runId,
      [
        {
          type: "fact.tool_completed",
          payload: { toolName: "bash", argsHash: "abc", artifactKey: "out", preview: `tool preview ${CRED_SECRET}` },
        } as FactEvent,
      ],
      v,
    ).newVersion;

    // fact.run_paused with errorMessage — surface 5.
    v = store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "provider_error",
            nodeId: "work",
            httpStatus: 500,
            provider: "anthropic",
            errorMessage: `error: ${CRED_SECRET} caused failure`,
          },
        } as FactEvent,
      ],
      v,
    ).newVersion;

    // fact.run_resumed to get back to running.
    v = store.appendFact(runId, [{ type: "fact.run_resumed", payload: {} } as FactEvent], v).newVersion;

    // intent.steering_requested.text — surface 5.
    store.appendIntent(runId, {
      type: "intent.steering_requested",
      payload: { text: `steer with ${AKIA_SECRET}` },
    } as IntentEvent);

    // intent.human_input.note — surface 5.
    store.appendIntent(runId, {
      type: "intent.human_input",
      payload: { route: "default", note: `human note ${CRED_SECRET}` },
    } as IntentEvent);

    // Terminal: fact.run_halted with detail — surface 5 (detail key).
    store.appendFact(
      runId,
      [{ type: "fact.run_halted", payload: { reason: "error", detail: `halted: ${AKIA_SECRET}` } } as FactEvent],
      v,
    );

    return runId;
  }

  function extractEvents(bytes: Uint8Array, runId: string): Array<{ type: string; payload: Record<string, unknown> }> {
    const entries = readTar(bytes);
    const evEntry = entries.find((e) => e.name === `runs/${runId}/events.jsonl`);
    if (evEntry == null) return [];
    return new TextDecoder()
      .decode(evEntry.data)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  }

  test("(a) CRED_SECRET absent from bundle bytes", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(CRED_SECRET)).toBe(false);
  });

  test("(b) AKIA_SECRET absent from bundle bytes", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(AKIA_SECRET)).toBe(false);
  });

  test("(c) fact.tool_completed.preview carries REDACTED marker", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const ev = events.find((e) => e.type === "fact.tool_completed");
    expect(ev).toBeDefined();
    expect(typeof ev!.payload["preview"]).toBe("string");
    expect(ev!.payload["preview"] as string).toContain("[REDACTED");
    expect(ev!.payload["preview"] as string).not.toContain(CRED_SECRET);
  });

  test("(d) fact.run_paused errorMessage carries REDACTED marker", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const ev = events.find((e) => e.type === "fact.run_paused");
    expect(ev).toBeDefined();
    expect(typeof ev!.payload["errorMessage"]).toBe("string");
    expect(ev!.payload["errorMessage"] as string).toContain("[REDACTED");
    expect(ev!.payload["errorMessage"] as string).not.toContain(CRED_SECRET);
  });

  test("(e) intent.steering_requested.text carries REDACTED marker", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const ev = events.find((e) => e.type === "intent.steering_requested");
    expect(ev).toBeDefined();
    expect(typeof ev!.payload["text"]).toBe("string");
    expect(ev!.payload["text"] as string).toContain("[REDACTED");
    expect(ev!.payload["text"] as string).not.toContain(AKIA_SECRET);
  });

  test("(f) intent.human_input.note carries REDACTED marker", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const ev = events.find((e) => e.type === "intent.human_input");
    expect(ev).toBeDefined();
    expect(typeof ev!.payload["note"]).toBe("string");
    expect(ev!.payload["note"] as string).toContain("[REDACTED");
    expect(ev!.payload["note"] as string).not.toContain(CRED_SECRET);
  });

  test("(g) fact.run_halted detail carries REDACTED marker", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const ev = events.find((e) => e.type === "fact.run_halted");
    expect(ev).toBeDefined();
    expect(typeof ev!.payload["detail"]).toBe("string");
    expect(ev!.payload["detail"] as string).toContain("[REDACTED");
    expect(ev!.payload["detail"] as string).not.toContain(AKIA_SECRET);
  });

  test("(h) genesis intent.run_enqueued routing values (input key + routing.inputs) are scrubbed", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    const genesis = events.find((e) => e.type === "intent.run_enqueued");
    expect(genesis).toBeDefined();
    const routing = genesis!.payload["routing"] as Record<string, unknown>;
    // A stale routing["input"] key (arbitrary string) is still scrubbed
    // by the generic scrubber even though the field is no longer part of
    // the contract.
    expect(typeof routing["input"]).toBe("string");
    expect(routing["input"] as string).toContain("[REDACTED");
    expect(routing["input"] as string).not.toContain(CRED_SECRET);
    // routing.inputs.apiKey contained AKIA_SECRET.
    const inputs = routing["inputs"] as Record<string, unknown>;
    expect(typeof inputs["apiKey"]).toBe("string");
    expect(inputs["apiKey"] as string).toContain("[REDACTED");
    expect(inputs["apiKey"] as string).not.toContain(AKIA_SECRET);
  });

  test("(i) structural fields survive untouched - nodeId/type/reason/route", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const events = extractEvents(bytes, runId);
    // The genesis event type must survive.
    const genesis = events.find((e) => e.type === "intent.run_enqueued");
    expect(genesis).toBeDefined();
    // fact.run_paused.reason must survive.
    const paused = events.find((e) => e.type === "fact.run_paused");
    expect(paused).toBeDefined();
    expect(paused!.payload["reason"]).toBe("provider_error");
    // intent.human_input.route must survive.
    const hi = events.find((e) => e.type === "intent.human_input");
    expect(hi).toBeDefined();
    expect(hi!.payload["route"]).toBe("default");
    // fact.tool_completed.toolName/argsHash/artifactKey must survive (structural strings).
    const tc = events.find((e) => e.type === "fact.tool_completed");
    expect(tc).toBeDefined();
    expect(tc!.payload["toolName"]).toBe("bash");
    expect(tc!.payload["argsHash"]).toBe("abc");
    expect(tc!.payload["artifactKey"]).toBe("out");
  });

  test("(j) importRunBundle derives correct status after event payload scrub", async () => {
    const src = freshStore();
    const runId = await seedRunWithEventSecrets(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runs).toEqual([{ runId, imported: true }]);
    // The run was halted as the last terminal event.
    const state = dst.getState(runId)!;
    expect(state.status).toBe("halted");
    // routing on the derived state still has its (now-scrubbed) input -
    // deriveRunState reads routing from the genesis payload which was scrubbed.
    expect(state.routing).toBeDefined();
    dst.close();
  });

  test("(k) stored events are NOT mutated by export", async () => {
    const store = freshStore();
    const runId = await seedRunWithEventSecrets(store);
    // Capture raw events before export.
    const rawEvents = store.getEvents(runId);
    const rawPayloads = rawEvents.map((e) => JSON.stringify(e.payload));
    store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    // Captured events after export must be identical.
    const afterEvents = store.getEvents(runId);
    const afterPayloads = afterEvents.map((e) => JSON.stringify(e.payload));
    expect(afterPayloads).toEqual(rawPayloads);
    // The raw store must still have the original secret.
    expect(afterPayloads.some((p) => p.includes(CRED_SECRET))).toBe(true);
    store.close();
  });
});

describe("exportRunBundle - artifact blob scrubbing with re-CAS", () => {
  const CRED_SECRET = "sk-ant-artifact-secretABCDEFGHIJ0123456789";
  const AKIA_SECRET = "AKIAIOSFODNN7EXAMPLE";

  /** Seed a run with two artifacts: one text (mime text/plain), one binary
   * (mime application/octet-stream), both containing the secret. */
  async function seedRunWithArtifactSecrets(
    store: ReturnType<typeof freshStore>,
  ): Promise<{ runId: string; origTextSha: string; origBinSha: string }> {
    const sha = await seedWorkflow(store, "c".repeat(64));
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
      initialRouting: { input: "seed" },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });

    const textContent = `secret=${CRED_SECRET} akia=${AKIA_SECRET} other=ok`;
    const textRef = store.putArtifact(
      { runId, nodeId: "work", iteration: 0, key: "report.txt" },
      new TextEncoder().encode(textContent),
      "text/plain",
    );

    const binContent = `secret=${CRED_SECRET} akia=${AKIA_SECRET} bytes=\x00\x01\x02`;
    const binRef = store.putArtifact(
      { runId, nodeId: "work", iteration: 0, key: "data.bin" },
      new TextEncoder().encode(binContent),
      "application/octet-stream",
    );

    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    return { runId, origTextSha: textRef.sha256, origBinSha: binRef.sha256 };
  }

  function extractArtifactRows(
    bytes: Uint8Array,
    runId: string,
  ): Array<{ key: string; blobSha: string; mime: string | null }> {
    const entries = readTar(bytes);
    const artEntry = entries.find((e) => e.name === `runs/${runId}/artifacts.jsonl`);
    if (artEntry == null) return [];
    return new TextDecoder()
      .decode(artEntry.data)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { key: string; blobSha: string; mime: string | null });
  }

  test("(a) secret is absent from the text blob tar entry after scrub", async () => {
    const store = freshStore();
    const { runId } = await seedRunWithArtifactSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    // The text artifact's blob entry must not contain the secrets.
    const entries = readTar(bytes);
    const rows = extractArtifactRows(bytes, runId);
    const textRow = rows.find((r) => r.key === "report.txt");
    expect(textRow).toBeDefined();
    const textBlobEntry = entries.find((e) => e.name === `blobs/${textRow!.blobSha}`);
    expect(textBlobEntry).toBeDefined();
    expect(Buffer.from(textBlobEntry!.data).includes(CRED_SECRET)).toBe(false);
    expect(Buffer.from(textBlobEntry!.data).includes(AKIA_SECRET)).toBe(false);

    // The text artifact's blob entry must contain the redaction marker.
    const blobContent = new TextDecoder().decode(textBlobEntry!.data);
    expect(blobContent).toContain("[REDACTED");

    // The binary artifact ships unchanged, so CRED_SECRET may still be in the
    // bundle (documented residual — see docs/proposals/secret-scrubbing.md §13).
    const binRow = rows.find((r) => r.key === "data.bin");
    expect(binRow).toBeDefined();
    const binBlobEntry = entries.find((e) => e.name === `blobs/${binRow!.blobSha}`);
    expect(binBlobEntry).toBeDefined();
    // Binary blob content is unchanged.
    const binContent = new TextDecoder().decode(binBlobEntry!.data);
    expect(binContent).toContain(CRED_SECRET);
  });

  test("(b) text artifact blobSha changes to new sha in artifact row", async () => {
    const store = freshStore();
    const { runId, origTextSha } = await seedRunWithArtifactSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const rows = extractArtifactRows(bytes, runId);
    const textRow = rows.find((r) => r.key === "report.txt");
    expect(textRow).toBeDefined();
    expect(textRow!.blobSha).not.toBe(origTextSha);
  });

  test("(c) manifest blobs[] uses the new sha; tar entry uses the same sha (consistency)", async () => {
    const store = freshStore();
    const { runId, origTextSha } = await seedRunWithArtifactSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;

    const rows = extractArtifactRows(bytes, runId);
    const textRow = rows.find((r) => r.key === "report.txt");
    expect(textRow).toBeDefined();
    const newSha = textRow!.blobSha;

    // The new sha must NOT be the original.
    expect(newSha).not.toBe(origTextSha);

    // The manifest blobs[] entry must list the new sha.
    const manifestBlob = manifest.blobs.find((b) => b.sha256 === newSha);
    expect(manifestBlob).toBeDefined();

    // The tar must have a blob entry under the new sha.
    const tarEntry = entries.find((e) => e.name === `blobs/${newSha}`);
    expect(tarEntry).toBeDefined();

    // The original sha must NOT appear as a blob tar entry.
    const origTarEntry = entries.find((e) => e.name === `blobs/${origTextSha}`);
    expect(origTarEntry).toBeUndefined();
  });

  test("(d) importRunBundle succeeds and imported artifact content shows [REDACTED", async () => {
    const src = freshStore();
    const { runId } = await seedRunWithArtifactSecrets(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runs).toEqual([{ runId, imported: true }]);

    const art = dst.getArtifact({ runId, nodeId: "work", iteration: 0, key: "report.txt" });
    const content = new TextDecoder().decode(art);
    expect(content).toContain("[REDACTED");
    expect(content).not.toContain(CRED_SECRET);
    expect(content).not.toContain(AKIA_SECRET);
    dst.close();
  });

  test("(e) binary artifact ships unchanged under its original sha (known residual)", async () => {
    const store = freshStore();
    const { runId, origBinSha } = await seedRunWithArtifactSecrets(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const rows = extractArtifactRows(bytes, runId);
    const binRow = rows.find((r) => r.key === "data.bin");
    expect(binRow).toBeDefined();
    // Binary blob sha is preserved as-is.
    expect(binRow!.blobSha).toBe(origBinSha);

    // The tar entry for the binary blob exists under the original sha.
    const entries = readTar(bytes);
    const tarEntry = entries.find((e) => e.name === `blobs/${origBinSha}`);
    expect(tarEntry).toBeDefined();
  });

  test("(f) application/json artifact is treated as text-ish and scrubbed", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store, "d".repeat(64));
    const runId = newRunId();
    store.enqueueRun({ runId, workflowSha: sha, initialRouting: { input: "x" } });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    const jsonContent = JSON.stringify({ result: "ok", key: CRED_SECRET });
    const ref = store.putArtifact(
      { runId, nodeId: "work", iteration: 0, key: "result.json" },
      new TextEncoder().encode(jsonContent),
      "application/json",
    );
    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    // Secret is absent.
    expect(Buffer.from(bytes).includes(CRED_SECRET)).toBe(false);

    // The artifact row sha changed.
    const rows = extractArtifactRows(bytes, runId);
    const jsonRow = rows.find((r) => r.key === "result.json");
    expect(jsonRow).toBeDefined();
    expect(jsonRow!.blobSha).not.toBe(ref.sha256);
  });

  test("(g) two text artifacts scrubbing to the same bytes dedupe to one blob", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store, "e".repeat(64));
    const runId = newRunId();
    store.enqueueRun({ runId, workflowSha: sha, initialRouting: { input: "x" } });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    // Both artifacts have the same secret content but stored under different keys
    // (so they have the same sha before scrubbing and still dedup after).
    const content = `key=${CRED_SECRET}`;
    const encoded = new TextEncoder().encode(content);
    store.putArtifact({ runId, nodeId: "work", iteration: 0, key: "a.txt" }, encoded, "text/plain");
    // putArtifact is CAS-deduped on same sha — use replace to force a second row
    // pointing at the same blob (same sha, same key content).
    store.putArtifact({ runId, nodeId: "work", iteration: 1, key: "b.txt" }, encoded, "text/plain");
    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const blobEntries = entries.filter((e) => e.name.startsWith("blobs/"));
    // Only one blob entry despite two artifact rows (CAS dedup).
    expect(blobEntries.length).toBe(1);

    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;
    // Manifest lists only one blob.
    expect(manifest.blobs.length).toBe(1);
  });

  test("(h) stored blobs are NOT mutated by export", async () => {
    const store = freshStore();
    const { runId, origTextSha } = await seedRunWithArtifactSecrets(store);
    // Read original bytes before export.
    const origBytes = store.getArtifact({ runId, nodeId: "work", iteration: 0, key: "report.txt" });
    const origContent = new TextDecoder().decode(origBytes);
    store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    // After export, the stored bytes are unchanged.
    const afterBytes = store.getArtifact({ runId, nodeId: "work", iteration: 0, key: "report.txt" });
    const afterContent = new TextDecoder().decode(afterBytes);
    expect(afterContent).toBe(origContent);
    expect(afterContent).toContain(CRED_SECRET);
    // The stored artifact row still has the original sha.
    const ref = store.getArtifactRef({ runId, nodeId: "work", iteration: 0, key: "report.txt" });
    expect(ref!.sha256).toBe(origTextSha);
    store.close();
  });
});

describe("exportRunBundle — spilled routing.inputs blob scrub + travel", () => {
  const CRED_SECRET = "sk-ant-spilled-secretABCDEFGH012345678";
  const AKIA_SECRET = "AKIAIOSFODNN7EXAMPLE";
  // Padding to ensure the value exceeds PER_VALUE_SPILL_BYTES (1024) so B1 spills it.
  const PADDING = "x".repeat(1100);
  const LARGE_VALUE = `${PADDING} cred=${CRED_SECRET} akia=${AKIA_SECRET} ${PADDING}`;

  async function seedRunWithSpilledInput(
    store: ReturnType<typeof freshStore>,
  ): Promise<{ runId: string; origRefSha: string }> {
    const sha = await seedWorkflow(store, "f".repeat(64));
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
      initialRouting: { inputs: { brief: LARGE_VALUE } },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    // Capture the original spilled blob sha from the stored genesis event.
    const events = store.getEvents(runId);
    const genesis = events.find((e) => e.type === "intent.run_enqueued")!;
    const gp = genesis.payload as Record<string, unknown>;
    const routing = gp["routing"] as Record<string, unknown>;
    const inputs = routing["inputs"] as Record<string, unknown>;
    const ref = inputs["brief"] as { $fragua_blob: string };
    return { runId, origRefSha: ref["$fragua_blob"] };
  }

  function extractGenesisRouting(bytes: Uint8Array, runId: string): Record<string, unknown> {
    const entries = readTar(bytes);
    const evEntry = entries.find((e) => e.name === `runs/${runId}/events.jsonl`)!;
    const lines = new TextDecoder().decode(evEntry.data).trim().split("\n");
    const genesis = lines
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
      .find((e) => e.type === "intent.run_enqueued")!;
    return genesis.payload["routing"] as Record<string, unknown>;
  }

  test("(a) B1 actually spills — genesis routing.inputs.brief is a blob ref pre-export", async () => {
    const store = freshStore();
    const { runId } = await seedRunWithSpilledInput(store);
    const events = store.getEvents(runId);
    const genesis = events.find((e) => e.type === "intent.run_enqueued")!;
    const gp = genesis.payload as Record<string, unknown>;
    const inputs = (gp["routing"] as Record<string, unknown>)["inputs"] as Record<string, unknown>;
    expect(isBlobRef(inputs["brief"])).toBe(true);
    store.close();
  });

  test("(b) provider-credential secret is absent from the full bundle bytes", async () => {
    const store = freshStore();
    const { runId } = await seedRunWithSpilledInput(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(CRED_SECRET)).toBe(false);
  });

  test("(c) AKIA pattern secret is absent from the full bundle bytes", async () => {
    const store = freshStore();
    const { runId } = await seedRunWithSpilledInput(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(AKIA_SECRET)).toBe(false);
  });

  test("(d) genesis routing ref sha is rewritten to the scrubbed sha in the export", async () => {
    const store = freshStore();
    const { runId, origRefSha } = await seedRunWithSpilledInput(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const routing = extractGenesisRouting(bytes, runId);
    const inputs = routing["inputs"] as Record<string, unknown>;
    expect(isBlobRef(inputs["brief"])).toBe(true);
    const exportedSha = (inputs["brief"] as { $fragua_blob: string })["$fragua_blob"];
    expect(exportedSha).not.toBe(origRefSha);
  });

  test("(e) manifest blobs[], tar entry, and routing ref all agree on the new sha", async () => {
    const store = freshStore();
    const { runId, origRefSha } = await seedRunWithSpilledInput(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;

    const routing = extractGenesisRouting(bytes, runId);
    const inputs = routing["inputs"] as Record<string, unknown>;
    const newSha = (inputs["brief"] as { $fragua_blob: string })["$fragua_blob"];

    // New sha is in manifest blobs[].
    expect(manifest.blobs.some((b) => b.sha256 === newSha)).toBe(true);
    // New sha has a tar entry.
    expect(entries.some((e) => e.name === `blobs/${newSha}`)).toBe(true);
    // Original sha has NO tar entry.
    expect(entries.some((e) => e.name === `blobs/${origRefSha}`)).toBe(false);
  });

  test("(f) importRunBundle succeeds and the spilled blob resolves via materializeRouting", async () => {
    const src = freshStore();
    const { runId } = await seedRunWithSpilledInput(src);
    const { bytes } = src.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    src.close();

    const dst = freshStore();
    const r = dst.importRunBundle(bytes);
    expect(r.runs).toEqual([{ runId, imported: true }]);

    const state = dst.getState(runId)!;
    const inputs = state.routing["inputs"] as Record<string, unknown>;
    // The ref is present in the imported state.
    expect(isBlobRef(inputs["brief"])).toBe(true);
    const exportedSha = (inputs["brief"] as { $fragua_blob: string })["$fragua_blob"];
    // The blob is resolvable in the imported store.
    const blobBytes = dst.readBlob(exportedSha);
    expect(blobBytes).not.toBeNull();
    // materializeRouting resolves to a scrubbed string (contains [REDACTED, not secrets).
    const materialized = materializeRouting(state.routing, (sha) => {
      const b = dst.readBlob(sha);
      if (b == null) throw new Error(`blob missing: ${sha}`);
      return b;
    });
    const resolved = (materialized["inputs"] as Record<string, unknown>)["brief"] as string;
    expect(typeof resolved).toBe("string");
    expect(resolved).toContain("[REDACTED");
    expect(resolved).not.toContain(CRED_SECRET);
    expect(resolved).not.toContain(AKIA_SECRET);
    dst.close();
  });

  test("(g) routing blob and same-content artifact blob deduplicate to one tar entry", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store, "g".repeat(64));
    const runId = newRunId();
    // Use LARGE_VALUE as both the spilled routing input AND the artifact content
    // so they hash to the same orig sha before scrubbing.
    store.enqueueRun({
      runId,
      workflowSha: sha,
      initialRouting: { inputs: { brief: LARGE_VALUE } },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    store.putArtifact(
      { runId, nodeId: "work", iteration: 0, key: "out.txt" },
      new TextEncoder().encode(LARGE_VALUE),
      "text/plain",
    );
    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "work" } }], v);

    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();

    const entries = readTar(bytes);
    const blobEntries = entries.filter((e) => e.name.startsWith("blobs/"));
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((e) => e.name === "manifest.json")!.data),
    ) as BundleManifest;
    // One blob entry and one manifest row despite two sources (routing + artifact).
    expect(blobEntries.length).toBe(1);
    expect(manifest.blobs.length).toBe(1);
  });

  test("(h) stored routing is NOT mutated by export — original blob still contains the secret", async () => {
    const store = freshStore();
    const { runId, origRefSha } = await seedRunWithSpilledInput(store);
    const routingBefore = JSON.stringify(store.getState(runId)!.routing);
    store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    const routingAfter = JSON.stringify(store.getState(runId)!.routing);
    expect(routingAfter).toBe(routingBefore);
    const origBlobBytes = store.readBlob(origRefSha);
    expect(origBlobBytes).not.toBeNull();
    expect(new TextDecoder().decode(origBlobBytes!)).toContain(CRED_SECRET);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// exportRunBundle — CI profile vs. export profile
// ---------------------------------------------------------------------------

describe("exportRunBundle - ci profile", () => {
  const CWD = "/home/dev/proj";
  const CRED_SECRET = "sk-ant-test-secretABCDEFGHIJ0123456789";
  const AKIA_SECRET = "AKIAIOSFODNN7EXAMPLE";
  const ENV_TOKEN = "ci-token-value-ABCDEFGHIJ12345678";

  async function seedRunWithMessage(store: ReturnType<typeof freshStore>, text: string): Promise<string> {
    const sha = await seedWorkflow(store, "a".repeat(64));
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      priority: 3,
      cwd: CWD,
      initialRouting: { input: "seed" },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    store.appendMessage(runId, {
      content: {
        role: "user" as const,
        content: [{ type: "text", text }],
        timestamp: 1,
      },
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

  test("(a) uses generic [REDACTED] markers — no :source suffix", async () => {
    const store = freshStore();
    const runId = await seedRunWithMessage(store, `cred=${CRED_SECRET}`);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test", labelMode: "generic" });
    store.close();

    const bundleText = new TextDecoder().decode(bytes);
    expect(bundleText).toContain("[REDACTED]");
    expect(bundleText).not.toContain("[REDACTED:");
  });

  test("(b) redacts a CI env secret fed as extraLiterals and reports liveLiteralHit=true", async () => {
    const store = freshStore();
    const runId = await seedRunWithMessage(store, `token=${ENV_TOKEN}`);
    const { bytes, liveLiteralHit } = store.exportRunBundle(runId, {
      fraguaVersion: "0.0.0-test",
      labelMode: "generic",
      extraLiterals: [{ value: ENV_TOKEN, source: "env:MY_TOKEN" }],
    });
    store.close();

    expect(Buffer.from(bytes).includes(ENV_TOKEN)).toBe(false);
    expect(liveLiteralHit).toBe(true);
  });

  test("(c) a pattern-only secret (AKIA…) is redacted but liveLiteralHit stays false", async () => {
    const store = freshStore();
    const runId = await seedRunWithMessage(store, `key=${AKIA_SECRET}`);
    const { bytes, liveLiteralHit } = store.exportRunBundle(runId, {
      fraguaVersion: "0.0.0-test",
      labelMode: "generic",
    });
    store.close();

    expect(Buffer.from(bytes).includes(AKIA_SECRET)).toBe(false);
    const bundleText = new TextDecoder().decode(bytes);
    expect(bundleText).toContain("[REDACTED]");
    expect(liveLiteralHit).toBe(false);
  });
});

describe("exportRunBundle - export profile (default)", () => {
  const CWD = "/home/dev/proj";
  const CRED_SECRET = "sk-ant-test-secretABCDEFGHIJ0123456789";

  async function seedRunWithCred(store: ReturnType<typeof freshStore>): Promise<string> {
    const sha = await seedWorkflow(store, "a".repeat(64));
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      priority: 3,
      cwd: CWD,
      initialRouting: { input: "seed" },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: CRED_SECRET }),
    });
    store.appendMessage(runId, {
      content: {
        role: "user" as const,
        content: [{ type: "text", text: `cred=${CRED_SECRET}` }],
        timestamp: 1,
      },
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

  test("(e) uses [REDACTED:source] labels and does not throw on a provider-cred literal hit", async () => {
    const store = freshStore();
    const runId = await seedRunWithCred(store);
    let result: ReturnType<typeof store.exportRunBundle> | undefined;
    expect(() => {
      result = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    }).not.toThrow();
    store.close();

    expect(result).toBeDefined();
    const bundleText = new TextDecoder().decode(result!.bytes);
    expect(bundleText).toContain("[REDACTED:provider_creds]");
    expect(bundleText).not.toContain(CRED_SECRET);
  });
});

// ---------------------------------------------------------------------------
// exportRunBundle — reason + route free-text scrubbing (gap fix)
// ---------------------------------------------------------------------------

describe("exportRunBundle — reason and route fields are scrubbed", () => {
  // A real secret shape that the scrubber will catch via pattern:anthropic_key.
  const SECRET = "sk-ant-api03-ReasonRouteTest0123456789abcdef";

  function extractEvents(bytes: Uint8Array, runId: string): Array<{ type: string; payload: Record<string, unknown> }> {
    const entries = readTar(bytes);
    const evEntry = entries.find((e) => e.name === `runs/${runId}/events.jsonl`);
    if (evEntry == null) return [];
    return new TextDecoder()
      .decode(evEntry.data)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  }

  async function seedRunWithReasonRoute(store: ReturnType<typeof freshStore>): Promise<string> {
    const sha = await seedWorkflow(store, "f".repeat(64));
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      cwd: "/home/dev/proj",
      initialRouting: { input: "seed" },
    });
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: SECRET }),
    });
    let v = store.getState(runId)!.version;
    const started: FactEvent = {
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
    };
    v = store.appendFact(runId, [started], v).newVersion;

    // intent.cancel_requested.payload.reason — free-form operator text.
    store.appendIntent(runId, {
      type: "intent.cancel_requested",
      payload: { reason: `cancelling because ${SECRET}` },
    } as IntentEvent);

    // intent.human_input.payload.route — operator-supplied route name.
    store.appendIntent(runId, {
      type: "intent.human_input",
      payload: { route: `route-${SECRET}`, note: "plain note" },
    } as IntentEvent);

    store.appendFact(
      runId,
      [{ type: "fact.run_halted", payload: { reason: "error", detail: "done" } } as FactEvent],
      v,
    );
    return runId;
  }

  test("(a) secret in intent.cancel_requested.reason is absent from bundle", async () => {
    const store = freshStore();
    const runId = await seedRunWithReasonRoute(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(SECRET)).toBe(false);
  });

  test("(b) intent.cancel_requested.reason shows [REDACTED in bundle events", async () => {
    const store = freshStore();
    const runId = await seedRunWithReasonRoute(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    const events = extractEvents(bytes, runId);
    const cancel = events.find((e) => e.type === "intent.cancel_requested");
    expect(cancel).toBeDefined();
    expect(cancel!.payload["reason"] as string).toContain("[REDACTED");
    expect(cancel!.payload["reason"] as string).not.toContain(SECRET);
  });

  test("(c) secret in intent.human_input.route is absent from bundle", async () => {
    const store = freshStore();
    const runId = await seedRunWithReasonRoute(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    expect(Buffer.from(bytes).includes(SECRET)).toBe(false);
  });

  test("(d) intent.human_input.route shows [REDACTED in bundle events", async () => {
    const store = freshStore();
    const runId = await seedRunWithReasonRoute(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    const events = extractEvents(bytes, runId);
    const hi = events.find((e) => e.type === "intent.human_input");
    expect(hi).toBeDefined();
    expect(hi!.payload["route"] as string).toContain("[REDACTED");
    expect(hi!.payload["route"] as string).not.toContain(SECRET);
  });

  test("(e) fact.run_halted.reason (structural enum value) survives scrub unchanged", async () => {
    const store = freshStore();
    const runId = await seedRunWithReasonRoute(store);
    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
    store.close();
    const events = extractEvents(bytes, runId);
    const halted = events.find((e) => e.type === "fact.run_halted");
    expect(halted).toBeDefined();
    // "error" is an enum value, not a secret — it must survive.
    expect(halted!.payload["reason"]).toBe("error");
  });
});
