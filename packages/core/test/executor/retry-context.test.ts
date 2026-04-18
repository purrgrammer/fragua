// Wave 3 — retry context propagation. The existing retry.test.ts pins
// backoff timing + event shape; this suite pins what the *retried call
// sees*. Spec (packages/core/src/executor/execute.ts): on each retry the
// executor stores `internal.retry_count.<nodeId>` in context so templates
// can react ("you are retrying — try a different approach"), and the
// outcome.context_updates from the prior failed attempt are discarded
// (retry is a fresh run, not a continuation).
//
// Nothing in this suite exercises the agent layer — we drive the
// MockCodergenBackend directly so the assertions stay on the contract.

import { describe, expect, test } from "bun:test";
import { substitute } from "../../src/engine/substitution.ts";
import { InMemorySink } from "../../src/events/sink.ts";
import { type CodergenInput, execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

describe("retry context propagation", () => {
  test("internal.retry_count.<nodeId> is visible to the retried node via ${context.*}", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        flaky [max_retries=2, prompt="attempt=\${context.internal.retry_count.flaky}"]
        done [shape=Msquare]
        s -> flaky -> done
      }
    `);
    const sink = new InMemorySink();
    const seenPrompts: string[] = [];
    await execute({
      graph,
      sink,
      random: () => 0.5,
      backend: new MockCodergenBackend((input: CodergenInput) => {
        seenPrompts.push(input.prompt);
        return seenPrompts.length < 3 ? fail("not yet") : ok({ notes: "finally" });
      }),
    });
    expect(seenPrompts).toHaveLength(3);
    // First attempt has no prior retries, so the counter substitutes to empty.
    expect(seenPrompts[0]).toBe("attempt=");
    // Retries bump it: after one failed attempt we're on retry 1, etc.
    expect(seenPrompts[1]).toBe("attempt=1");
    expect(seenPrompts[2]).toBe("attempt=2");
  });

  test("context_updates from a failed attempt do NOT bleed into the retry", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        flaky [max_retries=1, prompt="poisoned=\${context.poison}"]
        done [shape=Msquare]
        s -> flaky -> done
      }
    `);
    const sink = new InMemorySink();
    const seenPrompts: string[] = [];
    let attempt = 0;
    await execute({
      graph,
      sink,
      random: () => 0.5,
      backend: new MockCodergenBackend((input: CodergenInput) => {
        seenPrompts.push(input.prompt);
        attempt++;
        // First attempt fails AND tries to smuggle a context update forward.
        if (attempt === 1) return { ...fail("first try"), context_updates: { poison: "LEAK" } };
        return ok({ notes: "retry succeeded" });
      }),
    });
    // Per the retry contract, a FAILED attempt's context_updates are
    // discarded — the retry sees the pre-failure context.
    expect(seenPrompts[1]).toBe("poisoned=");
  });

  test("retry resolution uses the substitute helper's public contract (regression guard)", () => {
    // Guards against accidentally renaming `internal.retry_count.*` — the
    // executor writes that exact key, and this test anchors workflow
    // authors' ability to read it via the canonical ${context.…} form.
    const out = substitute("retry=${context.internal.retry_count.nodeA}", {
      context: { "internal.retry_count.nodeA": 4 },
    });
    expect(out).toBe("retry=4");
  });
});
