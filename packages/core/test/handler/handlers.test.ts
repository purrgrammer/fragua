import { describe, expect, test } from "bun:test";
import { makeHumanHandler } from "../../src/handler/handlers/human.ts";
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

describe("human handler", () => {
  const cfg = {
    nodeId: "signoff",
    text: "Drift report ready. Choose how to proceed.",
    routes: ["apply", "reject"],
    edges: [
      { route: "apply", to: "after" },
      { route: "reject", to: "draft" },
    ],
  };

  test("first call yields with the configured text and routes", async () => {
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ nodeId: "signoff" }));
    expect(result.kind).toBe("yield_human");
    if (result.kind === "yield_human") {
      expect(result.text).toBe("Drift report ready. Choose how to proceed.");
      expect(result.routes).toEqual(["apply", "reject"]);
    }
  });

  test("resume with humanInput.route sets transition.route for edge-selection", async () => {
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "apply" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.route).toBe("apply");
    }
  });

  test("resume picks the right route when two edges land on the same node", async () => {
    const spec = makeHumanHandler({
      nodeId: "signoff",
      text: "?",
      routes: ["output_only", "reject"],
      edges: [
        { route: "output_only", to: "done" },
        { route: "reject", to: "done" },
      ],
    });
    const result = await spec.handler(stubCtx({ humanInput: { route: "reject" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      // Both routes target `done`; the route name disambiguates which
      // edge fires via edge-selection's Step-0 (route attr).
      expect(result.route).toBe("reject");
    }
  });

  test("resume with bare string humanInput is treated as the route name", async () => {
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: "apply" }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.route).toBe("apply");
    }
  });

  test("route matching is case-sensitive", async () => {
    // Route names are identifier-shaped (D1). Upper/lower divergence is
    // a typo, not a UI nicety — halt with the same descriptive detail
    // an unknown route would produce.
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "APPLY" } }));
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/unknown route "APPLY"/);
    }
  });

  test("unknown route halts with descriptive detail", async () => {
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "ship" } }));
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.reason).toBe("error");
      expect(result.detail).toMatch(/human node "signoff": unknown route "ship" \(expected one of: apply, reject\)/);
    }
  });

  test("note is preserved into the audit envelope but ignored by routing", async () => {
    // The note rides inside intent.human_input's payload; the handler
    // sees it on `ctx.humanInput` but doesn't consume it. Sanity-check
    // that a populated note doesn't break the resume path.
    const spec = makeHumanHandler(cfg);
    const result = await spec.handler(stubCtx({ humanInput: { route: "apply", note: "lgtm" } }));
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.route).toBe("apply");
    }
  });

  test("construction throws when routes is empty", () => {
    expect(() => makeHumanHandler({ nodeId: "x", text: "?", routes: [], edges: [] })).toThrow(/at least one route/);
  });

  test("construction throws when a declared route has no matching edge", () => {
    expect(() =>
      makeHumanHandler({
        nodeId: "signoff",
        text: "?",
        routes: ["apply", "reject"],
        edges: [{ route: "apply", to: "x" }],
      }),
    ).toThrow(/route "reject" declared but no outgoing edge/);
  });

  test("construction throws when two edges share a route", () => {
    expect(() =>
      makeHumanHandler({
        nodeId: "signoff",
        text: "?",
        routes: ["apply"],
        edges: [
          { route: "apply", to: "x" },
          { route: "apply", to: "y" },
        ],
      }),
    ).toThrow(/duplicate edge for route "apply"/);
  });

  test("construction throws when an edge references an undeclared route", () => {
    expect(() =>
      makeHumanHandler({
        nodeId: "signoff",
        text: "?",
        routes: ["apply"],
        edges: [{ route: "ship", to: "x" }],
      }),
    ).toThrow(/edge route="ship" is not in declared routes/);
  });

  test('spec metadata is { kind: "human", sideEffect: "none", maxMs: 1000 }', () => {
    const spec = makeHumanHandler(cfg);
    expect(spec.kind).toBe("human");
    expect(spec.sideEffect).toBe("none");
    expect(spec.maxMs).toBe(1_000);
  });
});
