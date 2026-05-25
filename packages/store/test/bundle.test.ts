// Run-bundle export (docs/proposals/db-import.md): the deterministic tar
// writer round-trips through the system `tar`, and `exportRunBundle` carries
// the portable run record while NEVER emitting the seeded credential —
// secret-free by construction, no scrub.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BundleManifest, writeTar } from "../src/bundle.ts";
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
