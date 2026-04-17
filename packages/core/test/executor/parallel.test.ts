import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

describe("parallel + parallel.fan_in handlers", () => {
  const three_branches = `
    digraph {
      s [shape=Mdiamond]
      fan [shape=component, fan_in="join"]
      a [shape=box, prompt="review a"]
      b [shape=box, prompt="review b"]
      c [shape=box, prompt="review c"]
      join [shape=tripleoctagon]
      done [shape=Msquare]
      s -> fan
      fan -> a
      fan -> b
      fan -> c
      a -> join
      b -> join
      c -> join
      join -> done
    }
  `;

  test("three branches all succeed — fan_in reports 3/3 and pipeline succeeds", async () => {
    const graph = parseDotSource(three_branches);
    const seen: string[] = [];
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        seen.push(input.node.id);
        return ok({ notes: `${input.node.id} reviewed` });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(res.context["parallel.count"]).toBe(3);
    expect(res.context["parallel.successes"]).toBe(3);
  });

  test("partial failures → fan_in reports partial_success, pipeline continues", async () => {
    const graph = parseDotSource(three_branches);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        if (input.node.id === "b") return fail("b broke");
        return ok({ notes: `${input.node.id} ok` });
      }),
    });
    // fan_in returns partial_success → pipeline still completes without failure.
    expect(res.context["parallel.count"]).toBe(3);
    expect(res.context["parallel.successes"]).toBe(2);
    expect(res.outcome.status).not.toBe("fail");
  });

  test("all branches fail → fan_in node returns fail", async () => {
    const graph = parseDotSource(three_branches);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("boom")),
    });
    // The fan_in handler reports fail; pipeline routing is user's job.
    expect(res.node_outcomes["fan"]?.status).toBe("fail");
    expect(res.context["parallel.successes"]).toBe(0);
  });

  test("pipeline fails when join → fail-exit has goal_gate", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=component, fan_in="join"]
        a [shape=box, prompt="a"]
        b [shape=box, prompt="b"]
        join [shape=tripleoctagon]
        ok_exit [shape=Msquare, goal_gate=true]
        fail_exit [shape=Msquare]
        s -> fan
        fan -> a
        fan -> b
        a -> join
        b -> join
        join -> ok_exit [condition="outcome=success"]
        join -> fail_exit [condition="outcome=fail"]
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("all broke")),
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.goal_gates_satisfied).toBe(false);
  });

  test("branch context is isolated — writes don't leak between siblings", async () => {
    const graph = parseDotSource(three_branches);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        // Each branch writes its own key
        return ok({
          notes: `${input.node.id} done`,
          context_updates: { [`context.${input.node.id}_result`]: "yes" },
        });
      }),
    });
    expect(res.outcome.status).toBe("success");
    // All three branch updates should merge back to the parent context.
    expect(res.context["context.a_result"]).toBe("yes");
    expect(res.context["context.b_result"]).toBe("yes");
    expect(res.context["context.c_result"]).toBe("yes");
  });

  test("fan_in is not specified → inferred from shared tripleoctagon descendant", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=component]
        a [shape=box, prompt="a"]
        b [shape=box, prompt="b"]
        join [shape=tripleoctagon]
        done [shape=Msquare]
        s -> fan
        fan -> a
        fan -> b
        a -> join
        b -> join
        join -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => ok({ notes: input.node.id })),
    });
    expect(res.outcome.status).toBe("success");
    expect(res.context["parallel.count"]).toBe(2);
  });

  test("first_success join policy returns after first branch succeeds", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=component, fan_in="join", join_policy="first_success"]
        slow [shape=box, prompt="slow"]
        fast [shape=box, prompt="fast"]
        join [shape=tripleoctagon]
        done [shape=Msquare]
        s -> fan
        fan -> slow
        fan -> fast
        slow -> join
        fast -> join
        join -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(async (input) => {
        if (input.node.id === "slow") {
          await new Promise((r) => setTimeout(r, 50));
        }
        return ok({ notes: input.node.id });
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(res.context["parallel.successes"]).toBeGreaterThanOrEqual(1);
  });

  test("emits node events for branches AND fan_in", async () => {
    const graph = parseDotSource(three_branches);
    const sink = new InMemorySink();
    await execute({
      graph,
      sink,
      backend: new MockCodergenBackend((input) => ok({ notes: input.node.id })),
    });
    const completedIds = sink
      .byType("node.completed")
      .map((e) => e.node_id)
      .filter((id): id is string => typeof id === "string");
    // start, fan, a, b, c, join, done
    expect(completedIds).toContain("a");
    expect(completedIds).toContain("b");
    expect(completedIds).toContain("c");
    expect(completedIds).toContain("join");
    expect(completedIds).toContain("fan");
  });

  test("parallel node without fan_in that cannot be inferred → fails", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=component]
        a [shape=box, prompt="a"]
        b [shape=box, prompt="b"]
        done_a [shape=Msquare]
        done_b [shape=Msquare]
        s -> fan
        fan -> a
        fan -> b
        a -> done_a
        b -> done_b
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => ok({ notes: input.node.id })),
    });
    // two Msquare = validation error, but execute throws before that on findStart
    // Actually: two Msquares is fine structurally; validator would warn but execute runs it.
    // The fan has no shared tripleoctagon descendant → parallel handler should fail.
    expect(res.node_outcomes["fan"]?.status).toBe("fail");
    expect(res.node_outcomes["fan"]?.failure_reason).toContain("fan_in");
  });

  test("fan_in attr points to non-tripleoctagon → fails", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        fan [shape=component, fan_in="wrongshape"]
        a [shape=box, prompt="a"]
        wrongshape [shape=box, prompt="not a fan_in"]
        done [shape=Msquare]
        s -> fan
        fan -> a
        a -> wrongshape
        wrongshape -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
    });
    expect(res.node_outcomes["fan"]?.status).toBe("fail");
    expect(res.node_outcomes["fan"]?.failure_reason).toContain("tripleoctagon");
  });
});
