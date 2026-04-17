import { describe, expect, test } from "bun:test";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

describe("loop handler — trapezium shape with <promise>TAG</promise>", () => {
  test("exits when completion tag appears and strips it from notes", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        explore [shape=trapezium, until="PLAN_READY", max_iterations=5, prompt="iterate"]
        done [shape=Msquare]
        s -> explore -> done
      }
    `);
    let calls = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        calls++;
        return calls < 3 ? ok({ notes: "still thinking" }) : ok({ notes: "ok done <promise>PLAN_READY</promise>" });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(calls).toBe(3);
    expect(res.node_outcomes["explore"]!.notes).toBe("ok done");
    expect(res.node_outcomes["explore"]!.notes).not.toContain("promise");
  });

  test("fails after max_iterations with partial notes preserved", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, until="DONE", max_iterations=2, prompt="try"]
        done [shape=Msquare]
        s -> loop -> done [condition="outcome=success"]
        loop -> done [condition="outcome=fail"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "not yet" })),
    });
    expect(res.node_outcomes["loop"]!.status).toBe("fail");
    expect(res.node_outcomes["loop"]!.failure_reason).toContain("did not emit");
    expect(res.node_outcomes["loop"]!.failure_reason).toContain("<promise>DONE</promise>");
  });

  test("accumulates context_updates across iterations", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, until="GO", max_iterations=3, prompt="step"]
        done [shape=Msquare]
        s -> loop -> done
      }
    `);
    let i = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        i++;
        if (i === 1) return ok({ notes: "first", context_updates: { step_1: "a" } });
        if (i === 2) return ok({ notes: "second", context_updates: { step_2: "b" } });
        return ok({ notes: "<promise>GO</promise> final", context_updates: { step_3: "c" } });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(res.context["step_1"]).toBe("a");
    expect(res.context["step_2"]).toBe("b");
    expect(res.context["step_3"]).toBe("c");
  });

  test("missing 'until' attr → fail with a clear message", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, prompt="x"]
        done [shape=Msquare]
        s -> loop -> done [condition="outcome=success"]
        loop -> done [condition="outcome=fail"]
      }
    `);
    const res = await execute({ graph });
    expect(res.node_outcomes["loop"]!.status).toBe("fail");
    expect(res.node_outcomes["loop"]!.failure_reason).toContain("until");
  });

  test("a fail iteration does not abort the loop — next iteration still tries", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, until="OK", max_iterations=4, prompt="go"]
        done [shape=Msquare]
        s -> loop -> done
      }
    `);
    let i = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        i++;
        if (i === 1) return fail("transient 1");
        if (i === 2) return fail("transient 2");
        return ok({ notes: "settled <promise>OK</promise>" });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(i).toBe(3);
  });

  test("fresh_context=true produces distinct thread_ids across iterations", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, until="OK", max_iterations=3, fresh_context=true, prompt="go"]
        done [shape=Msquare]
        s -> loop -> done
      }
    `);
    const threads: Array<string | undefined> = [];
    let i = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        threads.push(input.thread_id);
        i++;
        return i < 2 ? ok({ notes: "keep going" }) : ok({ notes: "<promise>OK</promise>" });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(threads).toEqual(["loop:iter-1", "loop:iter-2"]);
  });

  test("case-insensitive tag match", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, until="DONE", max_iterations=2, prompt="x"]
        done [shape=Msquare]
        s -> loop -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "<promise>done</promise>" })),
    });
    expect(res.outcome.status).toBe("success");
  });
});
