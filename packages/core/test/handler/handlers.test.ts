import { describe, expect, test } from "bun:test";
import { makeWaitHumanHandler } from "../../src/handler/handlers/wait-human.ts";
import type { HandlerContext, ToolRegistry } from "../../src/handler/types.ts";

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

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
    tools: emptyRegistry,
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
    args: {},
    emit: () => {},
  };
  return { ...base, ...overrides };
}

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
    const result = await spec.handler(stubCtx({ nodeId: "wait", hitlInput: { answer: "approve" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("after");
      expect(result.routingDelta?.["hitl.wait"]).toEqual({ answer: "approve" });
    }
  });
});
