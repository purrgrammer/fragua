// `new SqliteStore({ migrate: false })` — the store-client open mode. Validates
// schema_version against the binary and refuses to create or bump. File-backed
// because the fresh-store refusal keys off `existsSync` (`:memory:` is always
// fresh). See packages/store/src/store.ts + migrations.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/index.ts";

describe("SqliteStore migrate:false open mode", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fragua-open-mode-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("nonexistent store: refuses and does not create the file", () => {
    const path = join(dir, "missing.db");
    expect(() => new SqliteStore({ path, migrate: false })).toThrow(/no fragua store.*harness/i);
    expect(existsSync(path)).toBe(false);
  });

  test("existing store: opens and can still write intents (no schema mutation)", () => {
    const path = join(dir, "store.db");
    const owner = new SqliteStore({ path }); // harness/daemon role bootstraps schema
    owner.saveWorkflow("wf1", "test", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", "{}", 1);
    owner.close();

    const client = new SqliteStore({ path, migrate: false });
    client.enqueueRun({ runId: "r1", workflowSha: "wf1", priority: 0 });
    const { seq } = client.appendIntent("r1", { type: "intent.pause_requested", payload: {} });
    expect(seq).toBeGreaterThan(0);
    client.close();
  });
});
