import { describe, expect, test } from "bun:test";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { ok } from "../../src/types/outcome.ts";

describe("codergen timeout", () => {
  test("node with timeout=50ms against a slow backend → fail with timeout reason", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        slow [prompt="hi", timeout="50ms"]
        done [shape=Msquare]
        s -> slow -> done [condition="outcome=success"]
        slow -> done [condition="outcome=fail"]
      }
    `);
    const backend = new MockCodergenBackend(async (input) => {
      // Hang until the parent signal aborts
      await new Promise((resolve) => {
        input.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
      return ok({ notes: "never" });
    });
    const res = await execute({ graph, backend });
    expect(res.node_outcomes["slow"]!.status).toBe("fail");
    expect(res.node_outcomes["slow"]!.failure_reason).toContain("timed out");
    expect(res.node_outcomes["slow"]!.failure_reason).toContain("50ms");
  });

  test("fast backend with a generous timeout → success", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        quick [prompt="hi", timeout="5s"]
        done [shape=Msquare]
        s -> quick -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "fast" })),
    });
    expect(res.node_outcomes["quick"]!.status).toBe("success");
  });

  test("timeout supports s / m / plain-ms suffix forms", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [prompt="x", timeout="1s"]
        b [prompt="y", timeout="2m"]
        c [prompt="z", timeout="500"]
        done [shape=Msquare]
        s -> a -> b -> c -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
    });
    expect(res.outcome.status).toBe("success");
    // All three nodes reached success — no timeout fired
    for (const id of ["a", "b", "c"]) {
      expect(res.node_outcomes[id]!.status).toBe("success");
    }
  });

  test("invalid timeout attr is ignored (no crash)", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        n [prompt="x", timeout="nonsense"]
        done [shape=Msquare]
        s -> n -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
    });
    expect(res.outcome.status).toBe("success");
  });
});
