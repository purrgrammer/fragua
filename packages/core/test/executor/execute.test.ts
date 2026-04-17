import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

function countBy<T, K extends string>(xs: T[], key: (x: T) => K): Record<K, number> {
  return xs.reduce(
    (acc, x) => {
      const k = key(x);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    {} as Record<K, number>,
  );
}

const now = (() => {
  let i = 0;
  return () => `2026-04-17T00:00:${String(i++).padStart(2, "0")}Z`;
})();

describe("execute — linear pipeline", () => {
  test("start → codergen → exit runs to completion", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        do_work [prompt="do it"]
        done [shape=Msquare]
        s -> do_work -> done
      }
    `);
    const sink = new InMemorySink();
    const res = await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "done" })),
      now,
    });
    expect(res.outcome.status).toBe("success");
    expect(res.completed_nodes).toEqual(["s", "do_work", "done"]);
    expect(res.node_outcomes["do_work"]!.notes).toBe("done");
    const types = sink.snapshot().map((e) => e.type);
    expect(types).toContain("pipeline.started");
    expect(types).toContain("pipeline.completed");
    const counts = countBy(sink.snapshot(), (e) => e.type);
    expect(counts["node.started"]).toBe(3);
    expect(counts["node.completed"]).toBe(3);
  });

  test("pipeline.started carries workflow_path and workflow_source when provided", async () => {
    const source = `
      digraph {
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `;
    const graph = parseDotSource(source);
    const sink = new InMemorySink();
    await execute({
      graph,
      sink,
      workflow_path: "workflows/w.dot",
      workflow_source: source,
    });
    const started = sink.snapshot().find((e) => e.type === "pipeline.started");
    expect(started).toBeDefined();
    const data = started!.data as { workflow_path?: string; workflow_source?: string };
    expect(data.workflow_path).toBe("workflows/w.dot");
    expect(data.workflow_source).toBe(source);
  });

  test("pipeline.started omits workflow_source when not provided", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `);
    const sink = new InMemorySink();
    await execute({ graph, sink });
    const started = sink.snapshot().find((e) => e.type === "pipeline.started");
    expect(started).toBeDefined();
    expect((started!.data as Record<string, unknown>)["workflow_source"]).toBeUndefined();
  });

  test("context.run_id and graph.* mirrored into context", async () => {
    const graph = parseDotSource(`
      digraph {
        graph [goal="ship"]
        s [shape=Mdiamond]
        done [shape=Msquare]
        s -> done
      }
    `);
    const res = await execute({ graph, run_id: "RUN-1" });
    expect(res.context["graph.run_id"]).toBe("RUN-1");
    expect(res.context["graph.goal"]).toBe("ship");
  });
});

describe("execute — edge selection drives routing", () => {
  test("conditional routing to success branch", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        work
        good [shape=Msquare]
        bad [shape=Msquare]
        s -> work
        work -> good [condition="outcome=success"]
        work -> bad [condition="outcome=fail"]
      }
    `);
    const res = await execute({ graph });
    expect(res.completed_nodes).toContain("good");
    expect(res.completed_nodes).not.toContain("bad");
  });

  test("failure routes to fail branch", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        work
        good [shape=Msquare]
        bad [shape=Msquare]
        s -> work
        work -> good [condition="outcome=success"]
        work -> bad [condition="outcome=fail"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("bad thing")),
    });
    expect(res.completed_nodes).toContain("bad");
  });

  test("suggested_next_ids steers routing", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        work
        a [shape=Msquare]
        b [shape=Msquare]
        s -> work
        work -> a
        work -> b
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ suggested_next_ids: ["b"] })),
    });
    expect(res.completed_nodes).toContain("b");
    expect(res.completed_nodes).not.toContain("a");
  });

  test("preferred_label steers routing via edge label", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        work
        y [shape=Msquare]
        n [shape=Msquare]
        s -> work
        work -> y [label="Yes"]
        work -> n [label="No"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ preferred_label: "yes" })),
    });
    expect(res.completed_nodes).toContain("y");
  });
});

describe("execute — retry and failure", () => {
  test("retries up to max_retries on fail outcome", async () => {
    let attempts = 0;
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        flaky [max_retries=3]
        done [shape=Msquare]
        s -> flaky -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        attempts++;
        return attempts < 3 ? fail("still failing") : ok({ notes: "finally" });
      }),
    });
    expect(attempts).toBe(3);
    expect(res.outcome.status).toBe("success");
  });

  test("exceeds max_retries → fail propagates", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        flaky [max_retries=1]
        done [shape=Msquare]
        s -> flaky -> done [condition="outcome=success"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("nope")),
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.completed_nodes).not.toContain("done");
  });

  test("max_steps guard prevents infinite loops", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop
        done [shape=Msquare]
        s -> loop
        loop -> loop
        loop -> done [condition="outcome=skipped"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok()),
      max_steps: 10,
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason).toContain("max_steps");
  });
});

describe("execute — goal gates", () => {
  test("unsatisfied goal gate routes to retry_target", async () => {
    let attempt = 0;
    const graph = parseDotSource(`
      digraph {
        graph [retry_target="work"]
        s [shape=Mdiamond]
        work [goal_gate=true]
        done [shape=Msquare]
        s -> work -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        attempt++;
        if (attempt < 2) return fail("not yet");
        return ok({ notes: "ok now" });
      }),
    });
    // first work fails → done terminal → gate unsatisfied → retry_target=work
    // second work succeeds → done terminal → gate satisfied
    expect(res.goal_gates_satisfied).toBe(true);
    expect(res.outcome.status).toBe("success");
  });

  test("unsatisfied goal gate with no retry_target → fail", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        work [goal_gate=true]
        done [shape=Msquare]
        s -> work -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("no")),
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason).toContain("goal gate");
  });
});

describe("execute — context + substitution", () => {
  test("$nodeId.output available to downstream nodes", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        plan [prompt="make a plan"]
        implement [prompt="based on $plan.output, do it"]
        done [shape=Msquare]
        s -> plan -> implement -> done
      }
    `);
    const prompts: string[] = [];
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        prompts.push(input.prompt);
        return ok({ notes: `output-of-${input.node.id}` });
      }),
    });
    expect(res.outcome.status).toBe("success");
    const implPrompt = prompts.find((p) => p.includes("do it"));
    expect(implPrompt).toBeDefined();
    expect(implPrompt).toContain("output-of-plan");
  });

  test("context updates from outcome propagate", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        configure
        check
        done [shape=Msquare]
        s -> configure -> check
        check -> done [condition="context.ready=true"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        if (input.node.id === "configure") return ok({ context_updates: { ready: true } });
        return ok();
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(res.context["ready"]).toBe(true);
    expect(res.completed_nodes).toContain("done");
  });
});

describe("execute — handler crash is captured as fail outcome", () => {
  test("backend throws → fail outcome", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        bad
        done [shape=Msquare]
        s -> bad -> done [condition="outcome=success"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        throw new Error("kaboom");
      }),
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.node_outcomes["bad"]!.failure_reason).toContain("kaboom");
  });
});

describe("execute — 1000 simulated linear runs remain deterministic", () => {
  test("same seed → identical outcomes", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a
        b
        c
        done [shape=Msquare]
        s -> a -> b -> c -> done
      }
    `);
    const results: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const res = await execute({
        graph,
        backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
        now: () => "2026-01-01T00:00:00Z",
      });
      results.push(res.completed_nodes.join(","));
    }
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBe("s,a,b,c,done");
  });
});
