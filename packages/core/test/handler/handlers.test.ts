import { describe, expect, test } from "bun:test";
import { makeLoopHandler, makeLoopExitHandler } from "../../src/handler/handlers/loop.ts";
import { makeWaitHumanHandler } from "../../src/handler/handlers/wait-human.ts";
import type { HandlerContext } from "../../src/handler/types.ts";

function stubCtx(
  overrides: Partial<HandlerContext> & { nodeId?: string; routing?: Record<string, unknown> } = {},
): HandlerContext {
  const base: HandlerContext = {
    runId: "r",
    nodeId: overrides.nodeId ?? "n",
    iteration: 0,
    signal: new AbortController().signal,
    routing: overrides.routing ?? {},
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: { get: () => { throw new Error("no tools"); }, has: () => false, list: () => [] },
    messages: {
      append: () => ({ ordinal: 0 }),
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: () => ({ runId: "r", nodeId: "n", iteration: 0, key: "", sha256: "", sizeBytes: 0, mime: null }),
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
  };
  return { ...base, ...overrides };
}

describe("loop handler", () => {
  const cfg = { bodyNode: "body", exitNode: "exit", maxIterations: 3 };

  test("first entry sets counter to 1 and transitions to body", async () => {
    const spec = makeLoopHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "loop1" }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("body");
      expect(result.routingDelta?.["loop:loop1"]).toBe(1);
      expect(result.routingDelta?.["loop_counter"]).toBe(1);
    }
  });

  test("subsequent entries increment counter", async () => {
    const spec = makeLoopHandler(cfg);
    const result = await spec.handler(
      stubCtx({ nodeId: "loop1", routing: { "loop:loop1": 2 } }),
    );
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta?.["loop:loop1"]).toBe(3);
    }
  });

  test("exceeding max halts with max_loops", async () => {
    const spec = makeLoopHandler(cfg);
    const result = await spec.handler(
      stubCtx({ nodeId: "loop1", routing: { "loop:loop1": 3 } }),
    );
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") expect(result.reason).toBe("max_loops");
  });

  test("exit handler transitions and resets loop_counter", async () => {
    const spec = makeLoopExitHandler(cfg);
    const result = await spec.handler(stubCtx());
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("exit");
      expect(result.routingDelta?.["loop_counter"]).toBe(0);
    }
  });
});

describe("wait.human handler", () => {
  const cfg = { prompt: "review PR", nextNode: "after" };

  test("first call yields for HITL with the configured prompt", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait" }));
    expect(result.kind).toBe("yield_hitl");
    if (result.kind === "yield_hitl") expect(result.prompt).toBe("review PR");
  });

  test("call with hitlInput transitions to nextNode and stores input", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(
      stubCtx({ nodeId: "wait", hitlInput: { answer: "approve" } }),
    );
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("after");
      expect(result.routingDelta?.["hitl.wait"]).toEqual({ answer: "approve" });
    }
  });
});
