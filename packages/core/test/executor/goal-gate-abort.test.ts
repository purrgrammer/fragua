// Wave 3 — goal-gate × abort interaction. Two separate features
// intersect here and have not been cross-tested before:
//
//   1. goal_gate=true forces a gated node's failure to route back to
//      retry_target (SPEC §4.1).
//   2. An agent's <abort>reason</abort> produces an outcome with
//      non_retryable=true, which the executor must respect even on a
//      goal-gate node — otherwise one aborting explorer would trigger
//      N retries that immediately re-abort for the same reason.
//
// Asserting this keeps future refactors of the retry loop from silently
// re-enabling retries on abort.

import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

const GATED = `
  digraph {
    graph [retry_target="explore", max_goal_gate_retries=3]
    s [shape=Mdiamond]
    explore [shape=box, prompt="probe", goal_gate=true]
    done [shape=Msquare]
    s -> explore -> done
  }
`;

describe("goal-gate × abort marker", () => {
  test("non_retryable fail on a goal-gate node bypasses retry_target", async () => {
    const sink = new InMemorySink();
    const attempts: string[] = [];
    const res = await execute({
      graph: parseDotSource(GATED),
      sink,
      backend: new MockCodergenBackend((input) => {
        attempts.push(input.node.id);
        // Emulate the agent's <abort>…</abort> path: fail + non_retryable.
        return fail("target is blocked", { non_retryable: true });
      }),
    });
    // Single attempt at the gated node — the retry loop must stay out of
    // the way when non_retryable is set.
    expect(attempts).toEqual(["explore"]);
    expect(res.outcome.status).toBe("fail");
    // The original reason is preserved — NOT "goal gate(s) unsatisfied".
    expect(res.outcome.failure_reason).toBe("target is blocked");
    // node.retrying was never emitted.
    expect(sink.byType("node.retrying")).toHaveLength(0);
  });

  test("regular (retryable) fail on a goal-gate node DOES retry through retry_target", async () => {
    const sink = new InMemorySink();
    const attempts: string[] = [];
    let calls = 0;
    await execute({
      graph: parseDotSource(GATED),
      sink,
      backend: new MockCodergenBackend((input) => {
        attempts.push(input.node.id);
        calls++;
        return calls <= 2 ? fail("transient") : ok({ notes: "recovered" });
      }),
    });
    // Contrast with the non_retryable case: the gate DOES drive retries
    // here until explore returns success on the 3rd attempt.
    expect(attempts.length).toBeGreaterThanOrEqual(3);
    expect(attempts[0]).toBe("explore");
  });
});
