import { describe, expect, test } from "bun:test";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

describe("goal-gate retry cap — prevents runaway retry loops", () => {
  const flaky = `
    digraph {
      graph [
        retry_target = "work"
        max_goal_gate_retries = 2
      ]
      s [shape=Mdiamond]
      work [shape=box, prompt="do thing", goal_gate=true]
      done [shape=Msquare]
      s -> work -> done
    }
  `;

  test("caps retries at max_goal_gate_retries and fails with a clear reason", async () => {
    let attempts = 0;
    const res = await execute({
      graph: parseDotSource(flaky),
      backend: new MockCodergenBackend(() => {
        attempts++;
        return fail("always broken");
      }),
    });

    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason).toMatch(/after 2 retries/);
    // 1 initial try + 2 retries = 3 total attempts at the goal-gate node
    expect(attempts).toBe(3);
  });

  test("default cap of 3 when max_goal_gate_retries is not set", async () => {
    const graph = parseDotSource(`
      digraph {
        graph [retry_target = "work"]
        s [shape=Mdiamond]
        work [shape=box, prompt="do thing", goal_gate=true]
        done [shape=Msquare]
        s -> work -> done
      }
    `);
    let attempts = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        attempts++;
        return fail("always broken");
      }),
    });
    expect(res.outcome.status).toBe("fail");
    // 1 initial + 3 retries = 4
    expect(attempts).toBe(4);
  });

  test("max_goal_gate_retries=0 fails immediately on first goal-gate miss", async () => {
    const graph = parseDotSource(`
      digraph {
        graph [retry_target = "work", max_goal_gate_retries = 0]
        s [shape=Mdiamond]
        work [shape=box, prompt="do thing", goal_gate=true]
        done [shape=Msquare]
        s -> work -> done
      }
    `);
    let attempts = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        attempts++;
        return fail("broken");
      }),
    });
    expect(res.outcome.status).toBe("fail");
    expect(attempts).toBe(1);
  });

  test("succeeds on the Nth retry without exhausting the cap", async () => {
    const graph = parseDotSource(flaky);
    let attempts = 0;
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => {
        attempts++;
        return attempts >= 3 ? ok({ notes: "got it" }) : fail("not yet");
      }),
    });
    expect(res.outcome.status).toBe("success");
    expect(attempts).toBe(3);
  });
});
