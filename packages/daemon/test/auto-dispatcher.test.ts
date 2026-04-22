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

  test("numeric maxMs wins over fallback", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.option(fc.integer({ min: 1, max: 1_000_000 })),
        (ms, fb) => {
          expect(resolveMaxMs({ maxMs: ms }, fb ?? undefined)).toBe(ms);
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

  test("maxMs wins over timeout when both present", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 10_000 }), (ms, secs) => {
        const attrs = { maxMs: ms, timeout: `${secs}s` };
        expect(resolveMaxMs(attrs, undefined)).toBe(ms);
      }),
    );
  });

  test("invalid timeout strings throw InvalidDurationError", () => {
    const bad = fc.oneof(
      fc.constantFrom("garbage", "", "   ", "0s", "-1", "5x", "1.5m", "5 m"),
      fc.string({ maxLength: 5 }).filter((s) => !/^\s*\d+(ms|s|m|h)?\s*$/.test(s)),
    );
    fc.assert(
      fc.property(bad, (timeout) => {
        expect(() => resolveMaxMs({ timeout }, undefined)).toThrow();
      }),
    );
  });
});
