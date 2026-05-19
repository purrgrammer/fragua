import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import fc from "fast-check";
import { autoDispatcherResolver, resolveMaxMs } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";

describe("autoDispatcherResolver", () => {
  test("parses YAML once and caches per-node specs", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", `name: t\nsteps:\n  mid: {type: llm, prompt: hi}\n`);

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));

    expect(dispatcher.get("sha", "start").kind).toBe("start");
    expect(dispatcher.get("sha", "mid").kind).toBe("codergen");
    expect(dispatcher.get("sha", "exit").kind).toBe("exit");

    store.close();
  });

  test("human nodes resolve to human", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `name: t
steps:
  ask:
    type: human
    text: "ok?"
    routes:
      yes: exit
`,
    );

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "ask");
    expect(spec.kind).toBe("human");
    store.close();
  });

  test("human node text comes from attrs.text", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `name: t
steps:
  g1:
    type: human
    text: "From text"
    routes: {go: exit}
`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "g1");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("yield_human");
    if (result.kind === "yield_human") expect(result.text).toBe("From text");
    store.close();
  });

  test("human node yield_human carries routes derived from attrs.routes", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `name: t
steps:
  review:
    type: human
    text: "Approve?"
    routes:
      approve: {to: publish, label: "Approve"}
      revise:  {to: revise, label: "Revise"}
  publish: {type: llm, prompt: p}
  revise: {type: llm, prompt: r}
`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "review");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("yield_human");
    if (result.kind === "yield_human") {
      expect(result.text).toBe("Approve?");
      expect(result.routes).toEqual(["approve", "revise"]);
    }
    store.close();
  });

  test("returns null for unknown workflows (dispatcher throws)", () => {
    const store = new SqliteStore({ path: ":memory:" });
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    expect(() => dispatcher.get("missing-sha", "x")).toThrow(/no handler registered/);
    store.close();
  });

  test("per-kind default maxMs flows to tool nodes without override", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `name: t\nsteps:\n  build: {type: tool, run: "echo hi"}\n`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store, defaultMaxMs: { tool: 12_345 } }));
    expect(dispatcher.get("sha", "build").maxMs).toBe(12_345);
    store.close();
  });

  test("step `timeout-minutes` attr beats config default", () => {
    const store = new SqliteStore({ path: ":memory:" });
    // 7 seconds via timeout-minutes is awkward; the IR retains `max_ms`
    // so we set max_ms directly via the legacy snake_case authoring form
    // the parser still accepts as an extra attr.
    store.saveWorkflow(
      "sha",
      "t",
      `name: t\nsteps:\n  build:\n    type: tool\n    run: "echo hi"\n    timeout-minutes: 0.1166\n`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store, defaultMaxMs: { tool: 12_345 } }));
    // 0.1166 minutes = 6996 ms ≈ 7s
    expect(dispatcher.get("sha", "build").maxMs).toBeLessThan(7_500);
    expect(dispatcher.get("sha", "build").maxMs).toBeGreaterThan(6_500);
    store.close();
  });
});

describe("resolveMaxMs — properties", () => {
  const nodeAttrsWithTimeout = fc.tuple(fc.integer({ min: 1, max: 10_000 }), fc.constantFrom("ms", "s", "m", "h")).map(
    ([n, u]) =>
      ({
        timeout: `${n}${u}`,
        _expected: n * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[u] ?? 1),
      }) as { timeout: string; _expected: number },
  );

  test("timeout string wins over fallback", () => {
    fc.assert(
      fc.property(nodeAttrsWithTimeout, fc.option(fc.integer({ min: 1, max: 1_000_000 })), (input, fallback) => {
        const attrs = { timeout: input.timeout } as { timeout: string };
        expect(resolveMaxMs(attrs, fallback ?? undefined)).toBe(input._expected);
      }),
    );
  });

  test("numeric max_ms wins over fallback", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.option(fc.integer({ min: 1, max: 1_000_000 })),
        (ms, fb) => {
          expect(resolveMaxMs({ max_ms: ms }, fb ?? undefined)).toBe(ms);
        },
      ),
    );
  });

  test("falls back when no attr is set", () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 1, max: 1_000_000 })), (fallback) => {
        const fb = fallback ?? undefined;
        expect(resolveMaxMs({}, fb)).toBe(fb as number);
      }),
    );
  });

  test("max_ms wins over timeout when both present", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 10_000 }), (ms, secs) => {
        const attrs = { max_ms: ms, timeout: `${secs}s` };
        expect(resolveMaxMs(attrs, undefined)).toBe(ms);
      }),
    );
  });

  test("invalid timeout strings throw InvalidDurationError", () => {
    const bad = fc.oneof(
      fc.constantFrom("garbage", "", "   ", "-1", "5x", "1.5m", "5 m"),
      fc.string({ maxLength: 5 }).filter((s) => !/^\s*\d+(ms|s|m|h)?\s*$/.test(s)),
    );
    fc.assert(
      fc.property(bad, (timeout) => {
        expect(() => resolveMaxMs({ timeout }, undefined)).toThrow();
      }),
    );
  });
});

describe("resolveMaxMs — zero sentinel", () => {
  test("max_ms=0 returns undefined", () => {
    expect(resolveMaxMs({ max_ms: 0 }, 1_000)).toBeUndefined();
  });

  test('timeout="0" returns undefined', () => {
    expect(resolveMaxMs({ timeout: "0" }, 1_000)).toBeUndefined();
    expect(resolveMaxMs({ timeout: "0s" }, 1_000)).toBeUndefined();
    expect(resolveMaxMs({ timeout: "0ms" }, 1_000)).toBeUndefined();
  });

  test("unset max_ms / timeout returns the per-kind fallback", () => {
    expect(resolveMaxMs({}, 60_000)).toBe(60_000);
    expect(resolveMaxMs({}, undefined)).toBeUndefined();
  });

  test("max_ms=5000 returns 5000", () => {
    expect(resolveMaxMs({ max_ms: 5_000 }, 60_000)).toBe(5_000);
  });

  test("fallback=0 returns undefined (config-level unbounded sentinel)", () => {
    expect(resolveMaxMs({}, 0)).toBeUndefined();
  });
});

describe("auto-dispatcher → codergenFactory unbounded propagation", () => {
  function captureMaxMsForNode(
    yaml: string,
    nodeId: string,
  ): { recordedMaxMs: number | "unbounded" | undefined; specMaxMs: number | undefined } {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", yaml);
    let recorded: number | "unbounded" | undefined;
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(
      autoDispatcherResolver({
        store,
        codergenFactory: (node, _next, maxMs) => {
          if (node.id === nodeId) recorded = maxMs;
          const spec: import("@swarm/core/handler").HandlerSpec = {
            kind: "codergen",
            sideEffect: "external",
            handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
          };
          if (maxMs === "unbounded") {
            // omit maxMs
          } else if (typeof maxMs === "number") {
            spec.maxMs = maxMs;
          } else {
            spec.maxMs = 4 * 60 * 60 * 1000;
          }
          return spec;
        },
      }),
    );
    const spec = dispatcher.get("sha", nodeId);
    const out = { recordedMaxMs: recorded, specMaxMs: spec.maxMs };
    store.close();
    return out;
  }

  test('max_ms=0 passes "unbounded" to the codergen factory', () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x, max_ms: 0}\n`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(yaml, "impl");
    expect(recordedMaxMs).toBe("unbounded");
    expect(specMaxMs).toBeUndefined();
  });

  test('timeout="0s" passes "unbounded" to the codergen factory', () => {
    const yaml = `name: t\nsteps:\n  impl:\n    type: llm\n    prompt: x\n    timeout: "0s"\n`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(yaml, "impl");
    expect(recordedMaxMs).toBe("unbounded");
    expect(specMaxMs).toBeUndefined();
  });

  test("no max_ms passes undefined to the codergen factory", () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
    const { recordedMaxMs } = captureMaxMsForNode(yaml, "impl");
    expect(recordedMaxMs).toBeUndefined();
  });

  test("max_ms=5000 passes the number 5000 to the codergen factory", () => {
    const yaml = `name: t\nsteps:\n  impl: {type: llm, prompt: x, max_ms: 5000}\n`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(yaml, "impl");
    expect(recordedMaxMs).toBe(5_000);
    expect(specMaxMs).toBe(5_000);
  });
});
