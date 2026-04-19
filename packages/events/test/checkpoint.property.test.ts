// Property-based tests for JsonlCheckpointStore.
//
// Invariants:
//   R1. Any valid Checkpoint round-trips: load(save(cp)) === cp.
//   R2. Concurrent save() calls never leave a torn file — load() after
//       the dust settles must return SOMETHING that deep-equals one of
//       the saved snapshots (the "last write wins" outcome is fine;
//       an intermediate corrupted file is not).
//   R3. A crash mid-save (simulated by leaving only the .tmp file)
//       means the previous valid checkpoint is still readable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { Checkpoint } from "@swarm/core";
import { JsonlCheckpointStore } from "../src/checkpoint.ts";

const outcomeArb: fc.Arbitrary<Checkpoint["node_outcomes"][string]> = fc.oneof(
  fc.record({
    status: fc.constantFrom("success" as const, "fail" as const, "partial_success" as const),
    notes: fc.option(fc.string({ maxLength: 50 }), { nil: undefined }),
  }),
);

const checkpointArb: fc.Arbitrary<Checkpoint> = fc
  .record({
    version: fc.constant(1 as const),
    run_id: fc.stringMatching(/^[a-z0-9-]{1,20}$/),
    workflow_sha: fc.stringMatching(/^[a-f0-9]{8,16}$/),
    current_node: fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
    completed_nodes: fc.array(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), { maxLength: 10 }),
    node_outcomes: fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), outcomeArb, { maxKeys: 5 }),
    context: fc.dictionary(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
      fc.oneof(fc.string({ maxLength: 30 }), fc.integer(), fc.boolean()),
      { maxKeys: 5 },
    ),
    retry_counts: fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/), fc.integer({ min: 0, max: 10 }), {
      maxKeys: 5,
    }),
    pi_sessions: fc.constant({} as Record<string, unknown>),
    saved_at: fc.constant("2026-04-19T00:00:00Z"),
    paused: fc.option(fc.boolean(), { nil: undefined }),
    last_applied_control_id: fc.option(fc.stringMatching(/^[a-z0-9-]{1,36}$/), { nil: undefined }),
  })
  .map((r) => {
    // TypeBox + JSON strip `undefined` — normalize the arb so round-trip
    // comparisons don't trip over `{k: undefined}` vs `{}`.
    const out = { ...r } as Record<string, unknown>;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as Checkpoint;
  });

describe("JsonlCheckpointStore — property: round-trip", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "swarm-cp-prop-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  test("R1: save then load is the identity for any valid checkpoint", async () => {
    await fc.assert(
      fc.asyncProperty(checkpointArb, async (cp) => {
        const store = new JsonlCheckpointStore({ runsDir });
        await store.save(cp.run_id, cp);
        const loaded = await store.load(cp.run_id);
        expect(loaded).toEqual(cp);
      }),
      { numRuns: 50 },
    );
  });

  test("R2: concurrent saves land one valid checkpoint (no torn file)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(checkpointArb, { minLength: 2, maxLength: 6 }), async (cps) => {
        // Share a run_id so they all target the same file.
        const runId = "shared-run";
        const normalized = cps.map((cp) => ({ ...cp, run_id: runId }));
        const store = new JsonlCheckpointStore({ runsDir });
        await Promise.all(normalized.map((cp) => store.save(runId, cp)));
        const loaded = await store.load(runId);
        // Whatever won the race must deep-equal one of the inputs.
        expect(normalized.some((cp) => JSON.stringify(cp) === JSON.stringify(loaded))).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  test("R3: a stray .tmp file from a prior crash doesn't disturb load", async () => {
    const store = new JsonlCheckpointStore({ runsDir });
    const good: Checkpoint = {
      version: 1,
      run_id: "r1",
      workflow_sha: "sha-0",
      current_node: "a",
      completed_nodes: ["s", "a"],
      node_outcomes: {},
      context: {},
      retry_counts: {},
      pi_sessions: {},
      saved_at: "2026-04-19T00:00:00Z",
    };
    await store.save("r1", good);

    // Simulate crash mid-next-save: leave a garbage .tmp next to the real file.
    await mkdir(join(runsDir, "r1"), { recursive: true });
    await writeFile(join(runsDir, "r1", "checkpoint.json.tmp"), "{corrupt\n");

    // load() reads checkpoint.json, not .tmp — so the prior valid
    // checkpoint is still returned untouched.
    const loaded = await store.load("r1");
    expect(loaded).toEqual(good);
  });

  test("load() returns undefined for a corrupted checkpoint.json", async () => {
    await mkdir(join(runsDir, "broken"), { recursive: true });
    await writeFile(join(runsDir, "broken", "checkpoint.json"), "not-json{}{{");
    const store = new JsonlCheckpointStore({ runsDir });
    expect(await store.load("broken")).toBeUndefined();
  });
});
