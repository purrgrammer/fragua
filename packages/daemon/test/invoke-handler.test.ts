import { describe, expect, test } from "bun:test";
import type * as core from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { invokeHandler } from "../src/invoke-handler.ts";

function deps(over: {
  handler: core.HandlerSpec["handler"];
  maxMs?: number;
  leakGraceMs?: number;
}): Parameters<typeof invokeHandler>[0] {
  const steerCtrl = new AbortController();
  const signals: AbortSignal[] = [steerCtrl.signal];
  if (over.maxMs !== undefined) signals.push(AbortSignal.timeout(over.maxMs));
  const signal = AbortSignal.any(signals);
  const spec = {
    kind: "step",
    sideEffect: "none",
    handler: over.handler,
    ...(over.maxMs !== undefined ? { maxMs: over.maxMs } : {}),
  } as core.HandlerSpec;
  return {
    spec,
    ctx: { signal } as core.HandlerContext,
    registry: new AbortRegistry(),
    runId: "r",
    steerCtrl,
    leakGraceMs: over.leakGraceMs ?? 50,
  };
}

describe("invokeHandler", () => {
  test("returns the handler result on normal completion", async () => {
    const out = await invokeHandler(
      deps({ handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }), maxMs: 1000 }),
    );
    expect(out.kind).toBe("result");
    if (out.kind === "result")
      expect(out.result).toEqual({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 });
  });

  test("tags a thrown AbortError as abortByName, a plain error as not", async () => {
    const aborted = await invokeHandler(
      deps({
        handler: async () => {
          const e = new Error("x");
          e.name = "AbortError";
          throw e;
        },
        maxMs: 1000,
      }),
    );
    expect(aborted).toMatchObject({ kind: "thrown", abortByName: true });

    const plain = await invokeHandler(
      deps({
        handler: async () => {
          throw new Error("boom");
        },
        maxMs: 1000,
      }),
    );
    expect(plain).toMatchObject({ kind: "thrown", abortByName: false });
    if (plain.kind === "thrown") expect((plain.error as Error).message).toBe("boom");
  });

  test("returns kind:leak when the handler ignores its signal past maxMs + leakGrace", async () => {
    const out = await invokeHandler(
      deps({
        // Never resolves and never observes the signal → the watchdog wins.
        handler: () => new Promise<core.HandlerResult>(() => {}),
        maxMs: 5,
        leakGraceMs: 5,
      }),
    );
    expect(out.kind).toBe("leak");
  });

  test("unregisters the run after completion (no leaked registry entry)", async () => {
    const d = deps({
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
      maxMs: 1000,
    });
    await invokeHandler(d);
    // A second register for the same run must not trip the already-registered
    // guard — proves the finally unregistered.
    expect(() => d.registry.register("r", new AbortController())).not.toThrow();
  });
});
