// selectAllOrphanSideEffects — the no-run-filter variant the startup sweep
// uses to find every crash-orphaned side-effect intent across all runs.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { selectAllOrphanSideEffects } from "../src/event-queries.ts";
import type { FactEvent } from "../src/index.ts";
import { freshStore, seedRun } from "./helpers.ts";

function dbOf(store: unknown): Database {
  return (store as { db: Database }).db;
}

function start(store: ReturnType<typeof freshStore>, runId: string): void {
  const s = store.getState(runId)!;
  const started: FactEvent = {
    type: "fact.run_started",
    payload: { workflowSha: s.workflowSha, contractVersion: s.contractVersion, startNode: "a" },
  };
  store.appendFact(runId, [started], s.version);
}

function intent(store: ReturnType<typeof freshStore>, runId: string, idempotencyKey: string): void {
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.side_effect_intent",
        payload: { nodeId: "a", iteration: 0, toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey },
      },
    ],
    s.version,
  );
}

function done(store: ReturnType<typeof freshStore>, runId: string, idempotencyKey: string): void {
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.side_effect_done", payload: { idempotencyKey, artifactKey: "result" } }],
    s.version,
  );
}

describe("selectAllOrphanSideEffects", () => {
  test("returns run_id+seq for every intent lacking done/failed across all runs", async () => {
    const store = freshStore();
    const runA = await seedRun(store);
    const runB = await seedRun(store);

    start(store, runA);
    intent(store, runA, "idem-a1"); // orphan
    intent(store, runA, "idem-a2"); // matched below
    done(store, runA, "idem-a2");

    start(store, runB);
    intent(store, runB, "idem-b1"); // orphan

    const orphans = selectAllOrphanSideEffects(dbOf(store));

    // Only the two orphans come back, unfiltered by run; the matched intent is excluded.
    expect(orphans.map((o) => o.run_id).sort()).toEqual([runA, runB].sort());

    const seqOfIntent = (runId: string, key: string): number =>
      store
        .getEvents(runId)
        .find(
          (e) =>
            e.type === "fact.side_effect_intent" && (e.payload as { idempotencyKey: string }).idempotencyKey === key,
        )!.seq;

    const byRun = new Map(orphans.map((o) => [o.run_id, o.seq]));
    expect(byRun.get(runA)).toBe(seqOfIntent(runA, "idem-a1"));
    expect(byRun.get(runB)).toBe(seqOfIntent(runB, "idem-b1"));
    store.close();
  });

  test("returns nothing when every intent has a matching done", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    start(store, runId);
    intent(store, runId, "idem-ok");
    done(store, runId, "idem-ok");

    expect(selectAllOrphanSideEffects(dbOf(store))).toHaveLength(0);
    store.close();
  });
});
