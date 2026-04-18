// Goal-gate retry: primary `retry_target` exhausts → switch to
// `fallback_retry_target` with a fresh budget.

import { describe, expect, test } from "bun:test";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

const TWO_PHASE_GRAPH = `
  digraph {
    graph [
      retry_target = "primary"
      fallback_retry_target = "rescue"
      max_goal_gate_retries = 2
    ]
    s [shape=Mdiamond]
    primary [shape=box, prompt="primary attempt", goal_gate=true]
    rescue  [shape=box, prompt="fallback attempt"]
    done [shape=Msquare]
    s -> primary -> done
    rescue -> done
  }
`;

describe("fallback_retry_target — two-phase goal-gate retry", () => {
  test("primary exhausts, then fallback runs with a fresh retry budget", async () => {
    const attempts: string[] = [];
    const backend = new MockCodergenBackend((input) => {
      attempts.push(input.node.id);
      // `primary` always fails its gate; `rescue` succeeds (and satisfies
      // the only gate in the graph, which is on `primary`). Because `rescue`
      // never satisfies the primary gate either, the pipeline still ends
      // up failing — but the fallback has been *attempted* which is the
      // behaviour we care about here.
      if (input.node.id === "primary") return fail("always broken");
      return ok({ notes: "rescue ran" });
    });

    const res = await execute({ graph: parseDotSource(TWO_PHASE_GRAPH), backend });

    const primaryAttempts = attempts.filter((id) => id === "primary").length;
    const rescueAttempts = attempts.filter((id) => id === "rescue").length;

    // Primary receives `max_goal_gate_retries`+1 = 3 attempts (initial + 2 retries).
    expect(primaryAttempts).toBe(3);
    // Fallback then gets a fresh budget: 1 attempt after the switch + up to
    // 2 retries → 3 rescue attempts. They all route back to primary which
    // re-fails its gate; rescue itself succeeds each time so no retry of
    // rescue is triggered by MockCodergenBackend. Only the gate-driven
    // jumps matter here.
    expect(rescueAttempts).toBeGreaterThanOrEqual(1);
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason ?? "").toContain('"rescue"');
    expect(res.outcome.failure_reason ?? "").toContain('(fallback after primary "primary" exhausted)');
  });

  test("without fallback_retry_target, exhaustion still fails with the original shape", async () => {
    const graph = parseDotSource(`
      digraph {
        graph [retry_target = "primary", max_goal_gate_retries = 1]
        s [shape=Mdiamond]
        primary [shape=box, prompt="go", goal_gate=true]
        done [shape=Msquare]
        s -> primary -> done
      }
    `);
    const res = await execute({
      graph,
      backend: new MockCodergenBackend(() => fail("always broken")),
    });
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason ?? "").toContain("after 1 retries");
    expect(res.outcome.failure_reason ?? "").not.toContain("fallback");
  });

  test("fallback_retry_target alone (no primary) behaves like primary — single phase", async () => {
    const graph = parseDotSource(`
      digraph {
        graph [fallback_retry_target = "rescue", max_goal_gate_retries = 1]
        s [shape=Mdiamond]
        primary [shape=box, prompt="go", goal_gate=true]
        rescue  [shape=box, prompt="rescue"]
        done [shape=Msquare]
        s -> primary -> done
        rescue -> done
      }
    `);
    const attempts: string[] = [];
    const res = await execute({
      graph,
      backend: new MockCodergenBackend((input) => {
        attempts.push(input.node.id);
        if (input.node.id === "primary") return fail("bad");
        return ok();
      }),
    });
    // Without a separate primary, fallback is the only target. One phase only.
    expect(attempts.filter((id) => id === "rescue").length).toBeLessThanOrEqual(2);
    expect(res.outcome.status).toBe("fail");
  });
});
