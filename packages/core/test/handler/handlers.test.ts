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
    nodeOutputs: new Map(),
    emit: () => {},
  };
  return { ...base, ...overrides };
}

describe("wait.human handler", () => {
  const cfg = {
    label: "Review PR",
    options: [
      { key: "A", label: "[A] Approve", to: "after" },
      { key: "R", label: "[R] Revise", to: "draft" },
    ],
  };

  test("first call yields for HITL with the configured label and options", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait" }));
    expect(result.kind).toBe("yield_hitl");
    if (result.kind === "yield_hitl") {
      expect(result.label).toBe("Review PR");
      expect(result.options).toHaveLength(2);
      expect(result.options[0]?.key).toBe("A");
    }
  });

  test("call with hitlInput transitions to chosen option's target", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait", hitlInput: { selected: "A" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.suggestedNextIds).toEqual(["after"]);
      expect(result.routingDelta?.["human.gate.selected"]).toBe("A");
    }
  });

  test("call with bare string hitlInput resolves option by key", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait", hitlInput: "R" }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.suggestedNextIds).toEqual(["draft"]);
    }
  });

  test("yield_hitl uses default label when cfg.label is unset", async () => {
    const spec = makeWaitHumanHandler({ options: cfg.options });
    const result = await spec.handler(stubCtx());
    expect(result.kind).toBe("yield_hitl");
    if (result.kind === "yield_hitl") {
      expect(result.label).toBe("Select an option:");
    }
  });

  test("selected key matching is case-insensitive", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const lower = await spec.handler(stubCtx({ hitlInput: { selected: "a" } }));
    expect(lower.kind).toBe("transition");
    if (lower.kind === "transition") {
      expect(lower.suggestedNextIds).toEqual(["after"]);
      // Routing delta carries the canonical (uppercase) key from the option.
      expect(lower.routingDelta?.["human.gate.selected"]).toBe("A");
    }
  });

  test("note propagates into human.gate.note when present", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ hitlInput: { selected: "A", note: "looks good" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta?.["human.gate.note"]).toBe("looks good");
      expect(result.routingDelta?.["human.gate.label"]).toBe("[A] Approve");
    }
  });

  test("empty-string note is treated as absent (no human.gate.note key)", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ hitlInput: { selected: "A", note: "" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta).not.toHaveProperty("human.gate.note");
    }
  });

  test("inputKey override mirrors the selected key into a custom routing slot", async () => {
    const spec = makeWaitHumanHandler({ ...cfg, inputKey: "review.decision" });
    const result = await spec.handler(stubCtx({ hitlInput: { selected: "R" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.routingDelta?.["review.decision"]).toBe("R");
      // Canonical keys are still written.
      expect(result.routingDelta?.["human.gate.selected"]).toBe("R");
    }
  });

  test("unknown selected key halts the run with a descriptive detail", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ hitlInput: { selected: "Z" } }));
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.reason).toBe("error");
      expect(result.detail).toMatch(/unknown selected key "Z"/);
      expect(result.detail).toMatch(/A, R/); // valid keys listed
    }
  });

  test("construction throws when options are empty", () => {
    expect(() => makeWaitHumanHandler({ options: [] })).toThrow(/at least one option/);
  });

  test("construction throws on duplicate accelerator keys", () => {
    expect(() =>
      makeWaitHumanHandler({
        options: [
          { key: "A", label: "Approve", to: "x" },
          { key: "a", label: "Acknowledge", to: "y" }, // collides after upper-casing
        ],
      }),
    ).toThrow(/duplicate accelerator key "A"/);
  });
});
