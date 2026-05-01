// Parallel fan-in discovery tests — attractor-spec §4.8 / §4.9.

import { describe, expect, test } from "bun:test";
import { discoverFanInTarget, findParallelParent, reachableFanInNodes } from "../../src/engine/parallel-discovery.ts";
import { parseDotSource } from "../../src/parser/parser.ts";

describe("discoverFanInTarget", () => {
  test("direct branch → tripleoctagon convergence", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        b [shape=box]
        c [shape=box]
        fan [shape=tripleoctagon]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        p -> c
        a -> fan
        b -> fan
        c -> fan
        fan -> done
      }
    `);
    const r = discoverFanInTarget(g, "p");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.fanInNode).toBe("fan");
      expect(r.branches.sort()).toEqual(["a", "b", "c"]);
    }
  });

  test("multi-hop branch path that converges still works", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        a2 [shape=box]
        b [shape=box]
        fan [shape=tripleoctagon]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        a -> a2
        a2 -> fan
        b -> fan
        fan -> done
      }
    `);
    const r = discoverFanInTarget(g, "p");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.fanInNode).toBe("fan");
  });

  test("no branches → no-branches", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        done [shape=Msquare]
        s -> p
      }
    `);
    expect(discoverFanInTarget(g, "p").kind).toBe("no-branches");
  });

  test("no tripleoctagon reachable → no-fan-in", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        b [shape=box]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        a -> done
        b -> done
      }
    `);
    expect(discoverFanInTarget(g, "p").kind).toBe("no-fan-in");
  });

  test("branches converge on different tripleoctagons → branches-diverge", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        b [shape=box]
        fan1 [shape=tripleoctagon]
        fan2 [shape=tripleoctagon]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        a -> fan1
        b -> fan2
        fan1 -> done
        fan2 -> done
      }
    `);
    const r = discoverFanInTarget(g, "p");
    expect(r.kind).toBe("branches-diverge");
  });

  test("multiple tripleoctagons reachable from all branches → ambiguous", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        b [shape=box]
        fan1 [shape=tripleoctagon]
        fan2 [shape=tripleoctagon]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        a -> fan1
        a -> fan2
        b -> fan1
        b -> fan2
        fan1 -> done
        fan2 -> done
      }
    `);
    const r = discoverFanInTarget(g, "p");
    expect(r.kind).toBe("ambiguous-fan-in");
    if (r.kind === "ambiguous-fan-in") {
      expect(r.candidates.sort()).toEqual(["fan1", "fan2"]);
    }
  });
});

describe("findParallelParent", () => {
  test("walks back from tripleoctagon to its component", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        p [shape=component]
        a [shape=box]
        b [shape=box]
        fan [shape=tripleoctagon]
        done [shape=Msquare]
        s -> p
        p -> a
        p -> b
        a -> fan
        b -> fan
        fan -> done
      }
    `);
    expect(findParallelParent(g, "fan")).toBe("p");
  });

  test("returns null when tripleoctagon has no parent component", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=tripleoctagon]
        done [shape=Msquare]
        s -> fan -> done
      }
    `);
    expect(findParallelParent(g, "fan")).toBeNull();
  });
});

describe("reachableFanInNodes", () => {
  test("does not traverse past tripleoctagon", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [shape=box]
        fan [shape=tripleoctagon]
        beyond [shape=box]
        done [shape=Msquare]
        s -> a -> fan -> beyond -> done
      }
    `);
    const set = reachableFanInNodes(g, "a");
    expect(set.has("fan")).toBe(true);
    expect(set.has("beyond")).toBe(false);
  });

  test("cycle-safe", () => {
    const g = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [shape=box]
        b [shape=box]
        done [shape=Msquare]
        s -> a -> b -> a
        a -> done
      }
    `);
    expect(() => reachableFanInNodes(g, "a")).not.toThrow();
  });
});
