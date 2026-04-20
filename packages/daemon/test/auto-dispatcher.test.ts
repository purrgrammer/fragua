import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
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
});
