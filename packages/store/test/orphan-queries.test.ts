// selectAllOrphanSideEffects — the no-run-filter variant the startup sweep
// uses to find every crash-orphaned side-effect intent across all runs.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  SELECT_ALL_ORPHAN_SIDE_EFFECTS_SQL,
  SELECT_ORPHAN_SIDE_EFFECTS_SQL,
  selectAllOrphanSideEffects,
  selectOrphanSideEffects,
} from "../src/event-queries.ts";
import type { FactEvent } from "../src/index.ts";
import { freshStore, medianMs, seedRun } from "./helpers.ts";

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

// Today's-semantics oracle: the per-intent join the anti-join replaced.
const LEGACY_ORPHAN_SQL = `
  SELECT i.run_id AS run_id, i.seq AS seq,
         json_extract(i.payload, '$.idempotencyKey') AS idempotencyKey,
         json_extract(i.payload, '$.toolName')       AS toolName,
         json_extract(i.payload, '$.nodeId')         AS nodeId
    FROM events i
    LEFT JOIN events d
           ON d.run_id = i.run_id
          AND d.type IN ('fact.side_effect_done','fact.side_effect_failed')
          AND json_extract(d.payload, '$.idempotencyKey') =
              json_extract(i.payload, '$.idempotencyKey')
   WHERE i.type   = 'fact.side_effect_intent'
     AND d.seq IS NULL
   ORDER BY i.run_id, i.seq
`;

interface LegacyOrphan {
  run_id: string;
  seq: number;
  idempotencyKey: string;
  toolName: string;
  nodeId: string;
}

function failed(store: ReturnType<typeof freshStore>, runId: string, idempotencyKey: string): void {
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.side_effect_failed", payload: { idempotencyKey, errorCode: "x", retriable: false } }],
    s.version,
  );
}

function badEventsPlanRows(db: Database, sql: string, params: string[]): string[] {
  const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return plan.map((r) => r.detail).filter((d) => /^SCAN (i|d)\b(?! USING)/.test(d) || d.includes("AUTOMATIC"));
}

describe("orphan detection — anti-join", () => {
  test("per-run orphan query matches legacy semantics on a fixed fixture", async () => {
    const store = freshStore();
    const runA = await seedRun(store);
    const runB = await seedRun(store);
    start(store, runA);
    start(store, runB);
    intent(store, runA, "a-orphan-1");
    intent(store, runA, "a-done");
    done(store, runA, "a-done");
    intent(store, runA, "a-failed");
    failed(store, runA, "a-failed");
    intent(store, runA, "shared");
    intent(store, runA, "a-orphan-2");
    intent(store, runB, "shared");
    done(store, runB, "shared");
    intent(store, runB, "b-orphan");

    const legacy = dbOf(store).query<LegacyOrphan, []>(LEGACY_ORPHAN_SQL).all();
    for (const runId of [runA, runB]) {
      const expected = legacy
        .filter((r) => r.run_id === runId)
        .map(({ idempotencyKey, toolName, nodeId }) => ({ idempotencyKey, toolName, nodeId }));
      expect(expected.length).toBeGreaterThan(0);
      expect(selectOrphanSideEffects(dbOf(store), runId)).toEqual(expected);
    }
    expect(selectOrphanSideEffects(dbOf(store), runA).map((r) => r.idempotencyKey)).toEqual([
      "a-orphan-1",
      "shared",
      "a-orphan-2",
    ]);
    store.close();
  });

  test("all-runs orphan query equals legacy restricted to non-terminal, non-imported runs", async () => {
    const store = freshStore();
    const db = dbOf(store);
    const statuses = [
      "queued",
      "running",
      "paused",
      "paused_human",
      "paused_auto",
      "completed",
      "cancelled",
      "halted",
      "quarantined",
    ] as const;
    const byStatus = new Map<string, string>();
    for (const status of statuses) {
      const runId = await seedRun(store);
      start(store, runId);
      intent(store, runId, `${status}-orphan`);
      intent(store, runId, `${status}-ok`);
      done(store, runId, `${status}-ok`);
      byStatus.set(runId, status);
    }
    const imported = await seedRun(store);
    start(store, imported);
    intent(store, imported, "imported-orphan");
    byStatus.set(imported, "running");
    for (const [runId, status] of byStatus) {
      db.query("UPDATE run_state SET status = ? WHERE run_id = ?").run(status, runId);
    }
    db.query("INSERT INTO imported_runs (run_id, imported_at) VALUES (?, 0)").run(imported);

    const live = new Set(["queued", "running", "paused", "paused_human", "paused_auto"]);
    const expected = db
      .query<LegacyOrphan, []>(LEGACY_ORPHAN_SQL)
      .all()
      .filter((r) => r.run_id !== imported && live.has(byStatus.get(r.run_id)!))
      .map(({ run_id, seq }) => ({ run_id, seq }));
    expect(expected).toHaveLength(5);
    expect(selectAllOrphanSideEffects(db)).toEqual(expected);
    store.close();
  });

  test("anti-join uses idx_events_side_effect_key", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    for (const [sql, params] of [
      [SELECT_ORPHAN_SIDE_EFFECTS_SQL, [runId]],
      [SELECT_ALL_ORPHAN_SIDE_EFFECTS_SQL, []],
    ] as const) {
      expect(badEventsPlanRows(dbOf(store), sql, [...params])).toEqual([]);
      const plan = dbOf(store)
        .query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((r) => r.detail);
      expect(plan.some((d) => d.includes("idx_events_side_effect_key"))).toBe(true);
    }
    store.close();
  });

  test("scales linearly: 2n intent/done pairs sweep < 2.5× n", async () => {
    const timeFor = async (pairs: number): Promise<number> => {
      const store = freshStore();
      const runId = await seedRun(store);
      start(store, runId);
      for (let i = 0; i < pairs; i += 250) {
        const facts: FactEvent[] = [];
        for (let j = i; j < Math.min(pairs, i + 250); j++) {
          const idempotencyKey = `k-${j}`;
          facts.push(
            {
              type: "fact.side_effect_intent",
              payload: { nodeId: "a", iteration: 0, toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey },
            },
            { type: "fact.side_effect_done", payload: { idempotencyKey, artifactKey: "result" } },
          );
        }
        store.appendFact(runId, facts, store.getState(runId)!.version);
      }
      const ms = medianMs(() => expect(store.startupSweep().quarantined).toEqual([]));
      store.close();
      return ms;
    };
    const n = await timeFor(2000);
    const n2 = await timeFor(4000);
    expect(n2 / n).toBeLessThan(2.5);
  }, 60_000);
});
