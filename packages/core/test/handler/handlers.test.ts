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
    withScope: () => {
      throw new Error("stubCtx: withScope not implemented for this test");
    },
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

  test("call with humanInput transitions to chosen option's target", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait", humanInput: { route: "A" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.suggestedNextIds).toEqual(["after"]);
    }
  });

  // The bug: when multiple HITL options route to the same target (e.g.
  // `[O] Output only -> done` and `[R] Reject -> done`), the engine's
  // edge selector falls through to Step 3 (`suggested_next_ids`) and
  // picks the first edge to that target — silently ambiguating which
  // option the operator chose in `selectedEdges` / UI highlighting.
  // The fix surfaces the chosen option's label as `preferredLabel` so
  // Step 2 disambiguates by edge label first.
  test("transition carries preferredLabel so the engine disambiguates parallel edges to the same target", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "R" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.preferredLabel).toBe("[R] Revise");
      // Both fields stay populated — preferredLabel narrows when labels
      // disambiguate; suggestedNextIds remains the fallback when an
      // author hasn't labelled their HITL edges.
      expect(result.suggestedNextIds).toEqual(["draft"]);
    }
  });

  test("call with bare string humanInput resolves option by key", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "wait", humanInput: "R" }));
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

  test("route matching is case-insensitive", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const lower = await spec.handler(stubCtx({ humanInput: { route: "a" } }));
    expect(lower.kind).toBe("transition");
    if (lower.kind === "transition") {
      expect(lower.suggestedNextIds).toEqual(["after"]);
    }
  });

  test("unknown route halts the run with a descriptive detail", async () => {
    const spec = makeWaitHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "Z" } }));
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.reason).toBe("error");
      expect(result.detail).toMatch(/unknown route "Z"/);
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
