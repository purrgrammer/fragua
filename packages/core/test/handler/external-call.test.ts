import { describe, expect, test } from "bun:test";
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

describe("externalCall", () => {
  test("emits INTENT then DONE; idempotency key is sha256 of canonical inputs", async () => {
    const { rec, log } = recorder();
    const call = makeExternalCall({
      runId: "r1",
      nodeId: "n1",
      iteration: 0,
      recorder: rec,
    });
    const result = await call({ toolName: "charge", args: { h: 1 } }, async (key) => `ok:${key}`);
    expect(log.intents).toHaveLength(1);
    expect(log.dones).toHaveLength(1);
    expect(log.faileds).toHaveLength(0);
    expect(log.intents[0]!.idempotencyKey).toBe(log.dones[0]!.idempotencyKey);
    expect(log.intents[0]!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toBe(`ok:${log.intents[0]!.idempotencyKey}`);
  });

  test("same inputs → same idempotency key (replay safety)", async () => {
    const { rec: r1 } = recorder();
    const { rec: r2 } = recorder();
    const mk = (rec: SideEffectRecorder) => makeExternalCall({ runId: "r", nodeId: "n", iteration: 2, recorder: rec });
    const keys: string[] = [];
    await mk(r1)({ toolName: "t", args: { a: 1 }, attempt: 3 }, async (k) => {
      keys.push(k);
      return 0;
    });
    await mk(r2)({ toolName: "t", args: { a: 1 }, attempt: 3 }, async (k) => {
      keys.push(k);
      return 0;
    });
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]!);
  });

  test("different attempts produce different keys", async () => {
    const { rec } = recorder();
    const call = makeExternalCall({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      recorder: rec,
    });
    const keys: string[] = [];
    await call({ toolName: "t", args: { a: 1 }, attempt: 1 }, async (k) => {
      keys.push(k);
      return 0;
    });
    await call({ toolName: "t", args: { a: 1 }, attempt: 2 }, async (k) => {
      keys.push(k);
      return 0;
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("clean failure records FAILED and rethrows", async () => {
    const { rec, log } = recorder();
    const call = makeExternalCall({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      recorder: rec,
    });
    const err = new Error("boom");
    await expect(
      call({ toolName: "t", args: { a: 1 } }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(log.faileds).toHaveLength(1);
    expect(log.dones).toHaveLength(0);
  });

  test("AbortError does NOT emit DONE or FAILED", async () => {
    const { rec, log } = recorder();
    const call = makeExternalCall({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      recorder: rec,
    });
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      call({ toolName: "t", args: { a: 1 } }, async () => {
        throw abortErr;
      }),
    ).rejects.toBe(abortErr);
    expect(log.intents).toHaveLength(1);
    expect(log.dones).toHaveLength(0);
    expect(log.faileds).toHaveLength(0);
  });

  test("args with different key insertion order produce the same idempotency key", async () => {
    const { rec: r1, log: l1 } = recorder();
    const { rec: r2, log: l2 } = recorder();
    const mk = (rec: SideEffectRecorder) => makeExternalCall({ runId: "r", nodeId: "n", iteration: 0, recorder: rec });
    await mk(r1)({ toolName: "t", args: { a: 1, b: [2, 3], c: { x: true, y: null } } }, async () => 0);
    await mk(r2)({ toolName: "t", args: { c: { y: null, x: true }, b: [2, 3], a: 1 } }, async () => 0);
    expect(l1.intents[0]!.idempotencyKey).toBe(l2.intents[0]!.idempotencyKey);
    expect(l1.intents[0]!.argsHash).toBe(l2.intents[0]!.argsHash);
  });

  test("non-serialisable args throw CanonicalStringifyError", async () => {
    const { rec } = recorder();
    const call = makeExternalCall({ runId: "r", nodeId: "n", iteration: 0, recorder: rec });
    await expect(call({ toolName: "t", args: { fn: () => 1 } }, async () => 0)).rejects.toThrow(/canonicalStringify/);
  });

  test("TimeoutError also skips DONE/FAILED", async () => {
    const { rec, log } = recorder();
    const call = makeExternalCall({
      runId: "r",
      nodeId: "n",
      iteration: 0,
      recorder: rec,
    });
    const err = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    await expect(
      call({ toolName: "t", args: { a: 1 } }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(log.dones).toHaveLength(0);
    expect(log.faileds).toHaveLength(0);
  });
});
