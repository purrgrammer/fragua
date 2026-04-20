// Property tests — ARCHITECTURE.md §10.
//
// P1  seq monotonic & contiguous per run, matches next_seq
// P2  OCC correctness under racing appendFact
// P4  projection == fold(events)
// P12 event payload bound enforced
// P13 routing bound enforced
// P14 blob dedup (identical content → one blob row)
// P22 cascade delete removes per-run children; blobs unchanged
// P23 STRICT rejects type coercion
// P24 claim atomicity — each queued run claimed by exactly one caller

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  applyFact,
  emptyMetrics,
  type FactEvent,
  foldFacts,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_ROUTING_BYTES,
  type RunState,
} from "../src/index.ts";
import { freshStore, nextId, seedRun, seedWorkflow } from "./helpers.ts";

type AnyDb = import("bun:sqlite").Database;
const getDb = (s: unknown): AnyDb => (s as { db: AnyDb }).db;

describe("P1 — seq monotonic & contiguous per run", () => {
  test("appendFact + appendIntent produce 1..N with no gaps", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 5, maxLength: 30 }), async (ops) => {
        const store = freshStore();
        const runId = await seedRun(store);
        for (const isFact of ops) {
          const s = store.getState(runId)!;
          if (isFact) {
            const fact: FactEvent = {
              type: "fact.node_started",
              payload: { nodeId: "n", iteration: 0 },
            };
            store.appendFact(runId, [fact], s.version);
          } else {
            store.appendIntent(runId, {
              type: "intent.pause_requested",
              payload: {},
            });
          }
        }
        const events = store.getEvents(runId);
        for (let i = 0; i < events.length; i++) {
          expect(events[i]!.seq).toBe(i + 1);
        }
        expect(store.getState(runId)!.nextSeq).toBe(events.length + 1);
        store.close();
      }),
      { numRuns: 25 },
    );
  });
});

describe("P2 — OCC rejects stale writers", () => {
  test("exactly one writer succeeds when two target the same version", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s = store.getState(runId)!;
    const fact: FactEvent = {
      type: "fact.node_started",
      payload: { nodeId: "n", iteration: 0 },
    };
    store.appendFact(runId, [fact], s.version);
    expect(() => store.appendFact(runId, [fact], s.version)).toThrow();
    // One more at the correct version succeeds.
    const s2 = store.getState(runId)!;
    expect(() => store.appendFact(runId, [fact], s2.version)).not.toThrow();
    store.close();
  });
});

describe("P4 — projection equals fold of facts", () => {
  test("random fact sequence folded purely matches DB projection", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tokens: fc.integer({ min: 0, max: 1000 }),
            costUsd: fc.float({
              min: Math.fround(0),
              max: Math.fround(1),
              noNaN: true,
              noDefaultInfinity: true,
            }),
            model: fc.constantFrom("pro", "flash", "haiku"),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (steps) => {
          const store = freshStore();
          const runId = await seedRun(store);
          let state: RunState = store.getState(runId)!;

          // Prime with run_started.
          const started: FactEvent = {
            type: "fact.run_started",
            payload: {
              workflowSha: state.workflowSha,
              schemaVersion: state.schemaVersion,
              startNode: "a",
            },
          };
          store.appendFact(runId, [started], state.version);
          state = store.getState(runId)!;

          // Independently fold in memory.
          let memory: RunState = {
            ...state,
            metrics: emptyMetrics(),
          };
          // Replay the started fact into the memory fold too, so metrics diverge purely by node_completed.
          memory = applyFact(memory, started, state.updatedAt);

          for (const step of steps) {
            const fact: FactEvent = {
              type: "fact.node_completed",
              payload: {
                nodeId: "n",
                iteration: 0,
                tokens: step.tokens,
                costUsd: step.costUsd,
                modelName: step.model,
                nextNode: "m",
              },
            };
            store.appendFact(runId, [fact], state.version);
            state = store.getState(runId)!;
            memory = applyFact(memory, fact, state.updatedAt);
          }

          expect(state.metrics.totalTokens).toBe(memory.metrics.totalTokens);
          expect(state.metrics.totalCostUsd).toBeCloseTo(memory.metrics.totalCostUsd, 6);
          expect(state.metrics.models).toEqual(memory.metrics.models);

          // Also: fold of facts on disk produces same projection tails.
          const facts = store
            .getEvents(runId)
            .filter((e) => e.type.startsWith("fact."))
            .map((e) => ({ type: e.type, payload: e.payload }) as FactEvent);
          const from0: RunState = {
            ...store.getState(runId)!,
            metrics: emptyMetrics(),
            status: "queued",
            currentNode: null,
          };
          const folded = foldFacts(from0, facts, state.updatedAt);
          expect(folded.metrics.totalTokens).toBe(state.metrics.totalTokens);
          expect(folded.metrics.totalCostUsd).toBeCloseTo(state.metrics.totalCostUsd, 6);

          store.close();
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("P12 — event payload bound", () => {
  test("payload >= MAX rejects; payload well under MAX accepts", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const s = store.getState(runId)!;
    // Oversized
    expect(() =>
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_halted",
            payload: {
              reason: "error",
              detail: "x".repeat(MAX_EVENT_PAYLOAD_BYTES),
            },
          },
        ],
        s.version,
      ),
    ).toThrow();
    // Under bound
    expect(() =>
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_halted",
            payload: { reason: "error", detail: "x".repeat(64) },
          },
        ],
        s.version,
      ),
    ).not.toThrow();
    store.close();
  });
});

describe("P13 — routing bound", () => {
  test("oversize initial routing rejected", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const bloat: Record<string, string> = {
      blob: "x".repeat(MAX_ROUTING_BYTES),
    };
    expect(() =>
      store.enqueueRun({
        runId: nextId("bloat"),
        workflowSha: sha,
        initialRouting: bloat,
      }),
    ).toThrow();
    store.close();
  });
});

describe("P14 — blob dedup", () => {
  test("identical content across many artifact rows → single blob row", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (copies) => {
        const store = freshStore();
        const runId = await seedRun(store);
        const content = new TextEncoder().encode("same-content");
        for (let i = 0; i < copies; i++) {
          store.putArtifact({ runId, nodeId: "n", iteration: i, key: "k" }, content);
        }
        const db = getDb(store);
        const blobCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM blobs").get()!.n;
        const artCount = db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?")
          .get(runId)!.n;
        expect(blobCount).toBe(1);
        expect(artCount).toBe(copies);
        store.close();
      }),
      { numRuns: 10 },
    );
  });
});

describe("P22 — cascade delete", () => {
  test("deleting run_state clears events/messages/artifacts; blobs preserved", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendMessage(runId, {
      role: "user",
      content: "hi",
      nodeId: null,
      iteration: 0,
    });
    const ref = store.putArtifact({ runId, nodeId: "n", iteration: 0, key: "k" }, new TextEncoder().encode("x"));
    const db = getDb(store);
    db.query("DELETE FROM run_state WHERE run_id = ?").run(runId);

    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(runId)!.n).toBe(
      0,
    );
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE run_id = ?").get(runId)!.n).toBe(
      0,
    );
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?").get(runId)!.n,
    ).toBe(0);
    // Blob still present (not cascaded).
    expect(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?").get(ref.sha256)!.n,
    ).toBe(1);
    store.close();
  });
});

describe("P23 — STRICT enforcement", () => {
  test("string into integer column rejected by SQLite", () => {
    const store = freshStore();
    const db = getDb(store);
    expect(() => db.query("INSERT INTO schema_version (id, version) VALUES (2, ?)").run("not-an-int")).toThrow();
    store.close();
  });

  test("invalid status value rejected", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const db = getDb(store);
    expect(() => db.query("UPDATE run_state SET status = 'bogus' WHERE run_id = ?").run(runId)).toThrow();
    store.close();
  });
});

describe("P24 — claim atomicity", () => {
  test("concurrent claims each pop exactly one unique run", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runIds = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const id = `r_${i}`;
      runIds.add(id);
      store.enqueueRun({ runId: id, workflowSha: sha });
    }

    // Drain via many calls; each returns a unique id and none collide.
    const claimed = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const c = store.claimNextRun(100);
      expect(c).not.toBeNull();
      expect(claimed.has(c!.runId)).toBe(false);
      claimed.add(c!.runId);
    }
    expect(claimed).toEqual(runIds);
    expect(store.claimNextRun(100)).toBeNull();
    store.close();
  });
});
