import { describe, expect, test } from "bun:test";
import {
  CheckpointValidationError,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../src/engine/checkpoint.ts";
import { CHECKPOINT_SCHEMA_VERSION, type Checkpoint } from "../../src/types/checkpoint.ts";
import { ok } from "../../src/types/outcome.ts";

function sample(): Checkpoint {
  return createCheckpoint({
    run_id: "run-1",
    workflow_sha: "sha-abc",
    current_node: "implement",
    completed_nodes: ["start", "plan"],
    node_outcomes: {
      plan: ok({ notes: "plan complete", context_updates: { plan_ready: true } }),
    },
    context: { "graph.goal": "ship", tests_passed: true },
    retry_counts: { implement: 0, plan: 1 },
    pi_sessions: { "thread-dev": { messages: ["hi"], opaque: true } },
    saved_at: "2026-04-17T00:00:00Z",
  });
}

describe("createCheckpoint", () => {
  test("attaches current schema version", () => {
    const cp = sample();
    expect(cp.version).toBe(CHECKPOINT_SCHEMA_VERSION);
  });
});

describe("serializeCheckpoint", () => {
  test("deterministic across key ordering", () => {
    const cp1 = sample();
    const cp2: Checkpoint = {
      saved_at: cp1.saved_at,
      retry_counts: cp1.retry_counts,
      pi_sessions: cp1.pi_sessions,
      version: cp1.version,
      workflow_sha: cp1.workflow_sha,
      run_id: cp1.run_id,
      current_node: cp1.current_node,
      completed_nodes: cp1.completed_nodes,
      node_outcomes: cp1.node_outcomes,
      context: cp1.context,
    };
    expect(serializeCheckpoint(cp1)).toBe(serializeCheckpoint(cp2));
  });

  test("stable inside nested objects", () => {
    const a = sample();
    const b = sample();
    // mutate nested object's key order
    b.context = Object.fromEntries(Object.entries(a.context).reverse()) as typeof a.context;
    expect(serializeCheckpoint(a)).toBe(serializeCheckpoint(b));
  });
});

describe("deserializeCheckpoint", () => {
  test("round-trip preserves data", () => {
    const cp = sample();
    const raw = serializeCheckpoint(cp);
    const decoded = deserializeCheckpoint(raw);
    expect(decoded).toEqual(cp);
  });

  test("invalid JSON throws CheckpointValidationError", () => {
    expect(() => deserializeCheckpoint("not json")).toThrow(CheckpointValidationError);
  });

  test("missing required fields throws with issues", () => {
    const raw = JSON.stringify({ version: CHECKPOINT_SCHEMA_VERSION });
    try {
      deserializeCheckpoint(raw);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointValidationError);
      expect((err as CheckpointValidationError).issues.length).toBeGreaterThan(0);
    }
  });

  test("wrong schema version is a validation error", () => {
    const raw = JSON.stringify({
      ...sample(),
      version: 999,
    });
    expect(() => deserializeCheckpoint(raw)).toThrow(CheckpointValidationError);
  });
});

describe("1000 round-trips — determinism under mutation", () => {
  test("randomized checkpoints round-trip to identical bytes", () => {
    let seed = 1234;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = 0; i < 1000; i++) {
      const cp = createCheckpoint({
        run_id: `run-${i}`,
        workflow_sha: `sha-${i}`,
        current_node: `node-${Math.floor(rand() * 10)}`,
        completed_nodes: Array.from({ length: Math.floor(rand() * 5) }, (_, k) => `c-${k}`),
        node_outcomes: {
          a: ok({ notes: `n${i}` }),
          b: ok({ context_updates: { count: Math.floor(rand() * 100) } }),
        },
        context: {
          goal: `g-${i}`,
          num: Math.floor(rand() * 999),
          ok: rand() > 0.5,
        },
        retry_counts: { a: Math.floor(rand() * 3) },
        pi_sessions: {},
        saved_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString(),
      });
      const once = serializeCheckpoint(cp);
      const twice = serializeCheckpoint(deserializeCheckpoint(once));
      expect(twice).toBe(once);
    }
  });
});
