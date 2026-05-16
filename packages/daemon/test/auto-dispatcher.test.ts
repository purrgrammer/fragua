import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import fc from "fast-check";
import { autoDispatcherResolver, resolveMaxMs } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";

describe("autoDispatcherResolver", () => {
  test("parses DOT once and caches per-node specs", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph G {
         start [shape=Mdiamond];
         mid [shape=box];
         finish [shape=Msquare];
         start -> mid -> finish;
       }`,
    );

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));

    const startSpec = dispatcher.get("sha", "start");
    expect(startSpec.kind).toBe("start");

    const midSpec = dispatcher.get("sha", "mid");
    expect(midSpec.kind).toBe("codergen");

    const finishSpec = dispatcher.get("sha", "finish");
    expect(finishSpec.kind).toBe("exit");

    store.close();
  });

  test("hexagon nodes resolve to wait.human", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         ask [shape=hexagon, prompt="ok?"];
         end [shape=Msquare];
         ask -> end;
       }`,
    );

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "ask");
    expect(spec.kind).toBe("wait.human");
    store.close();
  });

  test("hexagon question text comes from attrs.label (graphviz convention)", async () => {
    // Authors put question text on `label=` (the visible-name attr in
    // graphviz). Earlier code only read `prompt=`, so the UI showed
    // "waiting at <id>" instead of the authored question. Verify both
    // attrs work, with `label` winning.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         start [shape=Mdiamond]
         g1 [shape=hexagon, label="From label"]
         g2 [shape=hexagon, prompt="From prompt"]
         g3 [shape=hexagon, label="Label wins", prompt="From prompt"]
         done [shape=Msquare]
         start -> g1 -> g2 -> g3 -> done
       }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const [id, expected] of [
      ["g1", "From label"],
      ["g2", "From prompt"],
      ["g3", "Label wins"],
    ] as const) {
      const spec = dispatcher.get("sha", id);
      const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
      expect(result.kind).toBe("yield_hitl");
      if (result.kind === "yield_hitl") expect(result.label).toBe(expected);
    }
    store.close();
  });

  test("hexagon yield_hitl carries options derived from outgoing edge labels", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         start [shape=Mdiamond]
         review [shape=hexagon, prompt="Approve?"]
         publish [shape=box]
         revise [shape=box]
         done [shape=Msquare]
         start -> review
         review -> publish [label="[A] Approve"]
         review -> revise [label="[R] Revise"]
         publish -> done
         revise -> done
       }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "review");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("yield_hitl");
    if (result.kind === "yield_hitl") {
      expect(result.label).toBe("Approve?");
      expect(result.options).toHaveLength(2);
      expect(result.options.map((o) => o.key)).toEqual(["A", "R"]);
      expect(result.options.map((o) => o.to)).toEqual(["publish", "revise"]);
      expect(result.options[0]?.label).toBe("[A] Approve");
    }
    store.close();
  });

  test("hexagon options fall back to first-char of target id when label is unset", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         start [shape=Mdiamond]
         gate [shape=hexagon]
         next [shape=box]
         done [shape=Msquare]
         start -> gate
         gate -> next
         next -> done
       }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "gate");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("yield_hitl");
    if (result.kind === "yield_hitl") {
      expect(result.options[0]?.key).toBe("N"); // first char of `next`
      expect(result.options[0]?.label).toBe("next");
    }
    store.close();
  });

  test("hexagon with duplicate accelerator keys yields a halt spec at runtime", async () => {
    // Construction-level safeguard — validator catches this at lint
    // time with E010, but if a workflow somehow slipped past validation
    // (raw insert, older bug), the auto-dispatcher must still produce a
    // halt spec with a clear detail rather than crashing the dispatcher.
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         start [shape=Mdiamond]
         gate [shape=hexagon]
         a [shape=box]
         b [shape=box]
         done [shape=Msquare]
         start -> gate
         gate -> a [label="Approve"]
         gate -> b [label="Acknowledge"]
         a -> done
         b -> done
       }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "gate");
    expect(spec.kind).toBe("wait.human");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/duplicate accelerator key/);
      expect(result.detail).toMatch(/gate/);
    }
    store.close();
  });

  test("hexagon with no outgoing edges yields a halt spec at runtime", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph {
         start [shape=Mdiamond]
         dead [shape=hexagon]
         done [shape=Msquare]
         start -> dead
       }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "dead");
    const result = await spec.handler({} as Parameters<typeof spec.handler>[0]);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/at least one option/);
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
      `digraph { start [shape=Mdiamond]; build [shape=parallelogram, tool_command="echo hi"]; done [shape=Msquare]; start -> build -> done; }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store, defaultMaxMs: { tool: 12_345 } }));
    expect(dispatcher.get("sha", "build").maxMs).toBe(12_345);
    store.close();
  });

  test("node `timeout` attr beats config default and handler default", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph { start [shape=Mdiamond]; build [shape=parallelogram, tool_command="echo hi", timeout="7s"]; done [shape=Msquare]; start -> build -> done; }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store, defaultMaxMs: { tool: 12_345 } }));
    expect(dispatcher.get("sha", "build").maxMs).toBe(7_000);
    store.close();
  });

  test("malformed `timeout` attr yields a halt spec with clear detail", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(
      "sha",
      "t",
      `digraph { start [shape=Mdiamond]; bad [shape=parallelogram, tool_command="x", timeout="garbage"]; end [shape=Msquare]; start -> bad -> end; }`,
    );
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    const spec = dispatcher.get("sha", "bad");
    expect(spec.maxMs).toBeLessThanOrEqual(100);
    const fakeCtx = {} as Parameters<typeof spec.handler>[0];
    const result = await spec.handler(fakeCtx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") {
      expect(result.detail).toMatch(/bad/);
      expect(result.detail).toMatch(/garbage/);
    }
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
});

describe("auto-dispatcher → codergenFactory unbounded propagation", () => {
  function captureMaxMsForNode(
    dot: string,
    nodeId: string,
  ): { recordedMaxMs: number | "unbounded" | undefined; specMaxMs: number | undefined } {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("sha", "t", dot);
    let recorded: number | "unbounded" | undefined;
    const dispatcher = new Dispatcher();
    dispatcher.setResolver(
      autoDispatcherResolver({
        store,
        codergenFactory: (node, _next, maxMs) => {
          if (node.id === nodeId) recorded = maxMs;
          // Mirror the bridge's translation rule so we can assert
          // HandlerSpec.maxMs end-to-end as well.
          const spec: import("@swarm/core/handler").HandlerSpec = {
            kind: "codergen",
            sideEffect: "external",
            handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
          };
          if (maxMs === "unbounded") {
            // omit maxMs — unbounded
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

  test('DOT max_ms=0 passes "unbounded" to the codergen factory', () => {
    const dot = `digraph { start [shape=Mdiamond]; impl [shape=box, max_ms=0]; done [shape=Msquare]; start -> impl -> done; }`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(dot, "impl");
    expect(recordedMaxMs).toBe("unbounded");
    expect(specMaxMs).toBeUndefined();
  });

  test('DOT timeout="0s" passes "unbounded" to the codergen factory', () => {
    const dot = `digraph { start [shape=Mdiamond]; impl [shape=box, timeout="0s"]; done [shape=Msquare]; start -> impl -> done; }`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(dot, "impl");
    expect(recordedMaxMs).toBe("unbounded");
    expect(specMaxMs).toBeUndefined();
  });

  test("DOT with no max_ms passes undefined to the codergen factory", () => {
    const dot = `digraph { start [shape=Mdiamond]; impl [shape=box]; done [shape=Msquare]; start -> impl -> done; }`;
    const { recordedMaxMs } = captureMaxMsForNode(dot, "impl");
    expect(recordedMaxMs).toBeUndefined();
  });

  test("DOT max_ms=5000 passes the number 5000 to the codergen factory", () => {
    const dot = `digraph { start [shape=Mdiamond]; impl [shape=box, max_ms=5000]; done [shape=Msquare]; start -> impl -> done; }`;
    const { recordedMaxMs, specMaxMs } = captureMaxMsForNode(dot, "impl");
    expect(recordedMaxMs).toBe(5_000);
    expect(specMaxMs).toBe(5_000);
  });
});
