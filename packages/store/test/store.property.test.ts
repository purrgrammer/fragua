// Property tests — ARCHITECTURE.md §10.
//
// P1  seq monotonic & contiguous per run, matches next_seq
// P2  OCC correctness under racing appendFact
// P4  projection == fold(events)
// P12 event payload bound enforced
// P13 routing bound enforced
// P14 blob dedup (identical content → one blob row)
// P15 artifact loop scoping — same (run, node, key) across N iterations
//     produces N distinct rows, no PK violation
// P22 cascade delete removes per-run children; blobs unchanged
// P23 STRICT rejects type coercion
// P24 claim atomicity — each queued run claimed by exactly one caller
// P32 fan-out frontier isolation — `internal.active_nodes` changes only under
//     the frontier-mutating facts (fanout_started, dispatch_started,
//     node_completed, fanout_joined); applyFact never mutates its input

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import {
  ACTIVE_NODES_KEY,
  applyFact,
  emptyMetrics,
  type FactEvent,
  foldFacts,
  genesisToInitialState,
  getFrontier,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_ROUTING_BYTES,
  type RunState,
} from "../src/index.ts";
import { freshStore, nextId, seedRun, seedWorkflow } from "./helpers.ts";

type AnyDb = import("bun:sqlite").Database;
const getDb = (s: unknown): AnyDb => (s as { db: AnyDb }).db;

// invariant: P1 — per-run seq is monotonic and contiguous (1..N, no gaps).
// Load-bearing sentinel for daemon/test/invariant-coverage.test.ts.
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
      { numRuns: pbtRuns(25) },
    );
  });
});

// invariant: I3, P2 — facts are OCC-checked: a stale writer must lose the race;
// exactly one writer wins. Load-bearing sentinel for daemon/test/invariant-coverage.test.ts.
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

// invariant: I1, P4 — events + projection land in one txn, and the projection
// equals the pure fold of the fact log. Load-bearing sentinel for
// daemon/test/invariant-coverage.test.ts.
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
              contractVersion: state.contractVersion,
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

          expect(state.metrics.billedTokens).toBe(memory.metrics.billedTokens);
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
          expect(folded.metrics.billedTokens).toBe(state.metrics.billedTokens);
          expect(folded.metrics.totalCostUsd).toBeCloseTo(state.metrics.totalCostUsd, 6);

          store.close();
        },
      ),
      { numRuns: pbtRuns(20) },
    );
  });
});

// invariant: P12 — event payloads are capped at MAX_EVENT_PAYLOAD_BYTES.
// Load-bearing sentinel for daemon/test/invariant-coverage.test.ts.
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
            type: "fact.run_terminated",
            payload: { status: "errored", reason: "error", detail: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) },
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
            type: "fact.run_terminated",
            payload: { status: "errored", reason: "error", detail: "x".repeat(64) },
          },
        ],
        s.version,
      ),
    ).not.toThrow();
    store.close();
  });
});

// invariant: P13 — run_state.routing is capped at MAX_ROUTING_BYTES.
// Load-bearing sentinel for daemon/test/invariant-coverage.test.ts.
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
      { numRuns: pbtRuns(10) },
    );
  });
});

describe("P15 — artifact loop scoping across iterations", () => {
  test("same (runId, nodeId, key) across N iterations → N distinct rows, no PK violation", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const store = freshStore();
        const runId = await seedRun(store);
        // Use a distinct byte per iteration so each write hits a fresh sha.
        for (let i = 0; i < n; i++) {
          store.putArtifact({ runId, nodeId: "loop", iteration: i, key: "out" }, new Uint8Array([i]));
        }
        const db = getDb(store);
        const row = db
          .query<{ count: number; max_iter: number; keys: number }, [string]>(
            `SELECT COUNT(*) AS count,
                    MAX(iteration) AS max_iter,
                    COUNT(DISTINCT key) AS keys
               FROM artifacts
              WHERE run_id = ? AND node_id = 'loop'`,
          )
          .get(runId)!;
        expect(row.count).toBe(n);
        expect(row.max_iter).toBe(n - 1);
        expect(row.keys).toBe(1);

        // Fetching each iteration returns the content written at that iteration.
        for (let i = 0; i < n; i++) {
          const bytes = store.getArtifact({ runId, nodeId: "loop", iteration: i, key: "out" });
          expect(bytes[0]).toBe(i);
        }
        store.close();
      }),
      { numRuns: pbtRuns(15) },
    );
  });

  test("identical-content rewrite at the same scope is a no-op (one row, latest content)", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const scope = { runId, nodeId: "n", iteration: 0, key: "k" };
    // Replay-safe by default: same content at the same scope returns the
    // existing ref. No new artifact row, no version churn.
    const ref1 = store.putArtifact(scope, new TextEncoder().encode("v1"));
    const ref2 = store.putArtifact(scope, new TextEncoder().encode("v1"));
    expect(ref2.sha256).toBe(ref1.sha256);
    const db = getDb(store);
    const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?").get(runId)!.n;
    expect(n).toBe(1);
    expect(new TextDecoder().decode(store.getArtifact(scope))).toBe("v1");
    store.close();
  });

  test("different content at the same scope throws ArtifactCollisionError unless replace:true", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const scope = { runId, nodeId: "n", iteration: 0, key: "k" };
    store.putArtifact(scope, new TextEncoder().encode("v1"));
    expect(() => store.putArtifact(scope, new TextEncoder().encode("v2"))).toThrow(/artifact collision/i);
    expect(new TextDecoder().decode(store.getArtifact(scope))).toBe("v1");
    // Explicit replace overwrites in place.
    store.putArtifact(scope, new TextEncoder().encode("v2"), undefined, { replace: true });
    expect(new TextDecoder().decode(store.getArtifact(scope))).toBe("v2");
    const db = getDb(store);
    const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?").get(runId)!.n;
    expect(n).toBe(1);
    store.close();
  });
});

describe("P22 — cascade delete", () => {
  test("deleting run_state clears events/messages/artifacts; blobs preserved", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    store.appendMessage(runId, {
      content: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
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

// ─────────────── P32 — fan-out frontier isolation ───────────────

/** The only fact types whose reducer arm may touch `internal.active_nodes`. */
type FrontierMutatorType =
  | "fact.fanout_started"
  | "fact.dispatch_started"
  | "fact.node_completed"
  | "fact.fanout_joined";

// Keyed over Exclude<FactType, FrontierMutatorType> so adding a fact type to
// the union forces a classification here at typecheck time: either it joins
// this map (must not touch the frontier) or FrontierMutatorType (and gets a
// case in the legit-mutation test below).
const NON_MUTATOR_BUILDERS: {
  [T in Exclude<FactEvent["type"], FrontierMutatorType>]: (nodeId: string) => Extract<FactEvent, { type: T }>;
} = {
  "fact.run_started": () => ({
    type: "fact.run_started",
    payload: { workflowSha: "sha", contractVersion: 1, startNode: "a" },
  }),
  "fact.node_started": (n) => ({ type: "fact.node_started", payload: { nodeId: n, iteration: 0 } }),
  "fact.node_aborted": (n) => ({
    type: "fact.node_aborted",
    payload: { nodeId: n, iteration: 0, cause: "handler_error", partialTokens: 3, partialCostUsd: 0.01 },
  }),
  "fact.intents_folded": () => ({
    type: "fact.intents_folded",
    payload: { intentSeq: 2, folded: "intent.pause_requested" },
  }),
  "fact.side_effect_intent": (n) => ({
    type: "fact.side_effect_intent",
    payload: { nodeId: n, iteration: 0, toolName: "bash", argsHash: "h", attempt: 0, idempotencyKey: "k" },
  }),
  "fact.side_effect_done": () => ({
    type: "fact.side_effect_done",
    payload: { idempotencyKey: "k", artifactKey: "a" },
  }),
  "fact.side_effect_failed": () => ({
    type: "fact.side_effect_failed",
    payload: { idempotencyKey: "k", errorCode: "e", retriable: false },
  }),
  "fact.tool_completed": () => ({
    type: "fact.tool_completed",
    payload: { toolName: "bash", argsHash: "h", artifactKey: "a", preview: "p" },
  }),
  "fact.message_appended": (n) => ({
    type: "fact.message_appended",
    payload: { ordinal: 0, role: "assistant", nodeId: n, iteration: 0 },
  }),
  "fact.run_paused": (n) => ({ type: "fact.run_paused", payload: { reason: "operator", nodeId: n } }),
  "fact.provider_retry_attempted": (n) => ({
    type: "fact.provider_retry_attempted",
    payload: { nodeId: n, attempt: 1, httpStatus: 429, delayMs: 100 },
  }),
  "fact.run_resumed": () => ({ type: "fact.run_resumed", payload: { fromStatus: "paused" } }),
  "fact.run_terminated": (n) => ({ type: "fact.run_terminated", payload: { status: "completed", finalNode: n } }),
  "fact.snapshot_recorded": () => ({
    type: "fact.snapshot_recorded",
    payload: {
      eventIdx: 1,
      treeSha: "t",
      commitSha: "c",
      parentSnap: "p",
      headSha: null,
      headRef: null,
      diffBaseSha: "d",
      committed: null,
      uncommitted: null,
    },
  }),
  "fact.run_quarantined": () => ({ type: "fact.run_quarantined", payload: { reason: "other" } }),
  "fact.run_requeued_after_crash": () => ({ type: "fact.run_requeued_after_crash", payload: {} }),
  "fact.handler_timeout_leaked": (n) => ({
    type: "fact.handler_timeout_leaked",
    payload: { nodeId: n, leakedAt: 1_500 },
  }),
  "fact.daemon_takeover": () => ({ type: "fact.daemon_takeover", payload: { reclaimedFrom: 1, at: 1_500 } }),
  "fact.run_accepted": () => ({ type: "fact.run_accepted", payload: { sha: "s", replayed: 1, tailStaged: false } }),
  "fact.run_discarded": () => ({ type: "fact.run_discarded", payload: { refs: [] } }),
  // LEGACY (≤v3) read-only fold paths — never touch the frontier.
  "fact.run_completed": (n) => ({ type: "fact.run_completed", payload: { finalNode: n } }),
  "fact.run_halted": () => ({ type: "fact.run_halted", payload: { reason: "error" } }),
  "fact.run_cancelled": () => ({ type: "fact.run_cancelled", payload: { intentSeq: 1 } }),
  "fact.run_paused_human": (n) => ({
    type: "fact.run_paused_human",
    payload: { nodeId: n, text: "Approve?", routes: ["yes", "no"] },
  }),
};

const NON_MUTATOR_FACTS: ReadonlyArray<(nodeId: string) => FactEvent> = Object.values(NON_MUTATOR_BUILDERS);

const MUTATOR_FACTS: ReadonlyArray<(frontier: readonly string[]) => FactEvent> = [
  () => ({ type: "fact.fanout_started", payload: { nodeId: "par", iteration: 0, branches: ["x", "y"] } }),
  () => ({ type: "fact.dispatch_started", payload: { nodeId: "fresh", iteration: 0, resumeOf: "fresh" } }),
  (f) => ({
    type: "fact.node_completed",
    payload: { nodeId: f[0]!, iteration: 0, tokens: 5, costUsd: 0.01, nextNode: "join" },
  }),
  (f) => ({
    type: "fact.fanout_joined",
    payload: { nodeId: "par", iteration: 0, nextNode: "join", branchesCompleted: f.length },
  }),
];

const FRONTIER_BRANCHES = ["b1", "b2", "b3", "b4", "b5", "b6"] as const;
const arbFrontier = fc.uniqueArray(fc.constantFrom(...FRONTIER_BRANCHES), { minLength: 1, maxLength: 6 });

function fanOutState(frontier: readonly string[]): RunState {
  const state = genesisToInitialState(
    "r_pbt_frontier",
    {
      workflowSha: "sha",
      contractVersion: 1,
      projectId: "p",
      projectName: "p",
      routing: { description: "fan-out under test" },
    },
    1_000,
  );
  state.status = "running";
  state.currentNode = "par";
  state.dispatchStartedAt = 1_000;
  state.routing[ACTIVE_NODES_KEY] = [...frontier];
  return state;
}

describe("P32 — fan-out frontier isolation", () => {
  test("non-mutator facts leave a populated frontier untouched", () => {
    fc.assert(
      fc.property(
        arbFrontier,
        fc.nat(NON_MUTATOR_FACTS.length - 1),
        fc.boolean(),
        fc.nat(5),
        (frontier, factIdx, useFrontierNode, pick) => {
          const nodeId = useFrontierNode ? frontier[pick % frontier.length]! : "outsider";
          const state = fanOutState(frontier);
          const next = applyFact(state, NON_MUTATOR_FACTS[factIdx]!(nodeId), 2_000);
          expect(getFrontier(next.routing)).toEqual([...frontier]);
        },
      ),
      { numRuns: pbtRuns(250) },
    );
  });

  test("mutator-typed facts that miss the frontier are no-ops on it", () => {
    fc.assert(
      fc.property(arbFrontier, fc.nat(5), (frontier, pick) => {
        // Linear completion beside the frontier: advances the run pointer,
        // never touches the active set.
        const linearDone: FactEvent = {
          type: "fact.node_completed",
          payload: { nodeId: "outsider", iteration: 0, tokens: 1, costUsd: 0.01, nextNode: "m" },
        };
        const afterLinear = applyFact(fanOutState(frontier), linearDone, 2_000);
        expect(getFrontier(afterLinear.routing)).toEqual([...frontier]);
        expect(afterLinear.currentNode).toBe("m");

        // Re-dispatch of a node already in the frontier: no duplicate entry.
        const member = frontier[pick % frontier.length]!;
        const redispatch: FactEvent = {
          type: "fact.dispatch_started",
          payload: { nodeId: member, iteration: 0, resumeOf: "crash" },
        };
        const afterRedispatch = applyFact(fanOutState(frontier), redispatch, 2_000);
        expect(getFrontier(afterRedispatch.routing)).toEqual([...frontier]);
      }),
      { numRuns: pbtRuns(100) },
    );
  });

  test("legitimate mutators seed / advance / drain / clear the frontier", () => {
    fc.assert(
      fc.property(arbFrontier, fc.nat(5), (frontier, pick) => {
        // Seed: fanout_started over a frontier-less state.
        const preFan = fanOutState([]);
        delete preFan.routing[ACTIVE_NODES_KEY];
        const seeded = applyFact(
          preFan,
          { type: "fact.fanout_started", payload: { nodeId: "par", iteration: 0, branches: [...frontier] } },
          2_000,
        );
        expect(getFrontier(seeded.routing)).toEqual([...frontier]);

        // Advance: a fresh sub-node dispatch joins the active set.
        const advanced = applyFact(
          fanOutState(frontier),
          { type: "fact.dispatch_started", payload: { nodeId: "fresh", iteration: 0, resumeOf: "fresh" } },
          2_000,
        );
        expect(getFrontier(advanced.routing)).toEqual([...frontier, "fresh"]);

        // Drain: a frontier member's completion removes it and keeps
        // current_node pinned to the parallel node.
        const member = frontier[pick % frontier.length]!;
        const drained = applyFact(
          fanOutState(frontier),
          {
            type: "fact.node_completed",
            payload: { nodeId: member, iteration: 0, tokens: 1, costUsd: 0.01, nextNode: "join" },
          },
          2_000,
        );
        expect(getFrontier(drained.routing)).toEqual(frontier.filter((n) => n !== member));
        expect(drained.currentNode).toBe("par");

        // Clear: the join barrier deletes the key (not just empties it) and
        // advances current_node.
        const joined = applyFact(
          fanOutState(frontier),
          {
            type: "fact.fanout_joined",
            payload: { nodeId: "par", iteration: 0, nextNode: "join", branchesCompleted: frontier.length },
          },
          2_000,
        );
        expect(ACTIVE_NODES_KEY in joined.routing).toBe(false);
        expect(joined.currentNode).toBe("join");
      }),
      { numRuns: pbtRuns(100) },
    );
  });

  test("applyFact never mutates its input state (routing shallow copy is load-bearing)", () => {
    const allBuilders: ReadonlyArray<(frontier: readonly string[], nodeId: string) => FactEvent> = [
      ...MUTATOR_FACTS.map((b) => (f: readonly string[], _n: string) => b(f)),
      ...NON_MUTATOR_FACTS.map((b) => (_f: readonly string[], n: string) => b(n)),
    ];
    fc.assert(
      fc.property(
        arbFrontier,
        fc.nat(allBuilders.length - 1),
        fc.boolean(),
        fc.nat(5),
        (frontier, builderIdx, useFrontierNode, pick) => {
          const nodeId = useFrontierNode ? frontier[pick % frontier.length]! : "outsider";
          const state = fanOutState(frontier);
          const before = structuredClone(state);
          applyFact(state, allBuilders[builderIdx]!(frontier, nodeId), 2_000);
          expect(state).toEqual(before);
        },
      ),
      { numRuns: pbtRuns(250) },
    );
  });
});

// invariant: P24 — each queued run is claimed by exactly one caller.
// Load-bearing sentinel for daemon/test/invariant-coverage.test.ts.
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
