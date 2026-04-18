// JsonlCheckpointStore — atomic filesystem-backed CheckpointStore.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@swarm/core";
import { JsonlCheckpointStore } from "../src/checkpoint.ts";

function sampleCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: 1,
    run_id: "r1",
    workflow_sha: "sha",
    current_node: "plan",
    completed_nodes: ["s", "explore"],
    node_outcomes: {
      explore: { status: "success", context_updates: {}, preferred_label: "", suggested_next_ids: [], notes: "" },
    },
    context: { "graph.goal": "ship feature" },
    retry_counts: {},
    pi_sessions: { dev: [{ role: "assistant", content: [] }] },
    saved_at: "2026-04-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("JsonlCheckpointStore", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-ckpt-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("save → load round-trip preserves the snapshot", async () => {
    const store = new JsonlCheckpointStore({ runsDir: scratch });
    const snap = sampleCheckpoint();
    await store.save("r1", snap);
    const loaded = await store.load("r1");
    expect(loaded).toEqual(snap);
  });

  test("load of a non-existent run returns undefined (not an error)", async () => {
    const store = new JsonlCheckpointStore({ runsDir: scratch });
    expect(await store.load("never-ran")).toBeUndefined();
  });

  test("save overwrites the prior checkpoint atomically (no .tmp files left behind)", async () => {
    const store = new JsonlCheckpointStore({ runsDir: scratch });
    await store.save("r1", sampleCheckpoint({ current_node: "a" }));
    await store.save("r1", sampleCheckpoint({ current_node: "b" }));
    const dir = join(scratch, "r1");
    const files = await readdir(dir);
    expect(files.sort()).toEqual(["checkpoint.json"]);
    const raw = await readFile(join(dir, "checkpoint.json"), "utf8");
    expect((JSON.parse(raw) as Checkpoint).current_node).toBe("b");
  });
});
