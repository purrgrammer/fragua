// Property tests for makeExternalCall — idempotency-key invariant.
//
// The invariant: idempotencyKey is a pure function of
//   (runId, nodeId, iteration, argsHash, attempt)
// — nothing else. So:
//   1. Same tuple across two independent call sites → same key (replay safe).
//   2. Any change to any component of the tuple → different key.
//   3. On a single call, the INTENT and DONE facts (when both fire) share
//      the same idempotencyKey, and DONE never fires without a matching
//      INTENT.
//
// The fixed-example suite in external-call.test.ts already covers the
// happy path, abort/timeout skip, and clean-failure recording. This file
// exercises the key derivation across a wide parameter space.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { makeExternalCall } from "../../src/handler/external-call.ts";
import type { SideEffectRecorder } from "../../src/handler/types.ts";

interface Recorded {
  intents: Parameters<SideEffectRecorder["recordIntent"]>[0][];
  dones: Parameters<SideEffectRecorder["recordDone"]>[0][];
  faileds: Parameters<SideEffectRecorder["recordFailed"]>[0][];
}

function recorder(): { rec: SideEffectRecorder; log: Recorded } {
  const log: Recorded = { intents: [], dones: [], faileds: [] };
  return {
    log,
    rec: {
      recordIntent: (p) => log.intents.push(p),
      recordDone: (p) => log.dones.push(p),
      recordFailed: (p) => log.faileds.push(p),
    },
  };
}

const idArb = fc.string({ minLength: 1, maxLength: 16 }).filter((s) => !s.includes("\x00"));

async function invoke(args: {
  runId: string;
  nodeId: string;
  iteration: number;
  toolName: string;
  argsHash: string;
  attempt: number;
}): Promise<{ intentKey: string; doneKey: string }> {
  const { rec, log } = recorder();
  const call = makeExternalCall({
    runId: args.runId,
    nodeId: args.nodeId,
    iteration: args.iteration,
    recorder: rec,
  });
  await call({ toolName: args.toolName, argsHash: args.argsHash, attempt: args.attempt }, async () => 0);
  return {
    intentKey: log.intents[0]!.idempotencyKey,
    doneKey: log.dones[0]!.idempotencyKey,
  };
}

describe("externalCall — idempotency-key properties", () => {
  test("replay safety: same (runId, nodeId, iteration, argsHash, attempt) → same key", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        fc.integer({ min: 1, max: 20 }),
        async (runId, nodeId, iteration, toolName, argsHash, attempt) => {
          const a = await invoke({ runId, nodeId, iteration, toolName, argsHash, attempt });
          const b = await invoke({ runId, nodeId, iteration, toolName, argsHash, attempt });
          expect(a.intentKey).toBe(b.intentKey);
          expect(a.doneKey).toBe(b.doneKey);
          expect(a.intentKey).toBe(a.doneKey);
        },
      ),
    );
  });

  test("key is a 64-char hex sha256 for any valid input", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        fc.integer({ min: 1, max: 20 }),
        async (runId, nodeId, iteration, toolName, argsHash, attempt) => {
          const { intentKey } = await invoke({ runId, nodeId, iteration, toolName, argsHash, attempt });
          expect(intentKey).toMatch(/^[0-9a-f]{64}$/);
        },
      ),
    );
  });

  test("different attempt → different key", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        async (runId, nodeId, iteration, toolName, argsHash, a, b) => {
          if (a === b) return; // precondition
          const ka = (await invoke({ runId, nodeId, iteration, toolName, argsHash, attempt: a })).intentKey;
          const kb = (await invoke({ runId, nodeId, iteration, toolName, argsHash, attempt: b })).intentKey;
          expect(ka).not.toBe(kb);
        },
      ),
    );
  });

  test("different argsHash → different key", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        idArb,
        async (runId, nodeId, iteration, toolName, hashA, hashB) => {
          if (hashA === hashB) return;
          const ka = (await invoke({ runId, nodeId, iteration, toolName, argsHash: hashA, attempt: 1 })).intentKey;
          const kb = (await invoke({ runId, nodeId, iteration, toolName, argsHash: hashB, attempt: 1 })).intentKey;
          expect(ka).not.toBe(kb);
        },
      ),
    );
  });

  test("different (runId | nodeId | iteration) → different key", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        async (runA, node, iter, tool, hash, iter2, runB) => {
          if (runA === runB && iter === iter2) return;
          const ka = (
            await invoke({ runId: runA, nodeId: node, iteration: iter, toolName: tool, argsHash: hash, attempt: 1 })
          ).intentKey;
          const kb = (
            await invoke({ runId: runB, nodeId: node, iteration: iter2, toolName: tool, argsHash: hash, attempt: 1 })
          ).intentKey;
          expect(ka).not.toBe(kb);
        },
      ),
    );
  });

  test("on success, INTENT and DONE share the same key (no orphan DONE)", () => {
    fc.assert(
      fc.asyncProperty(
        idArb,
        idArb,
        fc.nat({ max: 100 }),
        idArb,
        idArb,
        fc.integer({ min: 1, max: 10 }),
        async (runId, nodeId, iteration, toolName, argsHash, attempt) => {
          const { rec, log } = recorder();
          const call = makeExternalCall({ runId, nodeId, iteration, recorder: rec });
          await call({ toolName, argsHash, attempt }, async () => 0);
          expect(log.intents).toHaveLength(1);
          expect(log.dones).toHaveLength(1);
          expect(log.dones[0]!.idempotencyKey).toBe(log.intents[0]!.idempotencyKey);
        },
      ),
    );
  });

  test("on clean failure, FAILED shares INTENT's key; DONE does not fire", () => {
    fc.assert(
      fc.asyncProperty(idArb, idArb, idArb, async (runId, nodeId, argsHash) => {
        const { rec, log } = recorder();
        const call = makeExternalCall({ runId, nodeId, iteration: 0, recorder: rec });
        await expect(
          call({ toolName: "t", argsHash, attempt: 1 }, async () => {
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(log.intents).toHaveLength(1);
        expect(log.dones).toHaveLength(0);
        expect(log.faileds).toHaveLength(1);
        expect(log.faileds[0]!.idempotencyKey).toBe(log.intents[0]!.idempotencyKey);
      }),
    );
  });
});
