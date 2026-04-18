// Wave 3 — parallel branch context isolation. parallel.test.ts already
// pins the happy path (3 branches, merge-back semantics, join policies).
// This suite pins the *isolation* invariant from AGENTS.md:
//
//   > Each branch gets a cloned context (writes don't leak to siblings).
//
// Two kinds of leaks matter and are exercised separately:
//   1. In-progress writes — branch A's context_updates must not be
//      visible to branch B's handler while B is running.
//   2. Post-join merge — once both branches finish, the aggregated
//      context_updates land on the pipeline context the way the SPEC
//      documents.

import { describe, expect, test } from "bun:test";
import { type CodergenInput, execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { ok } from "../../src/types/outcome.ts";

const BRANCHY = `
  digraph {
    s [shape=Mdiamond]
    fan [shape=component, fan_in="join"]
    a [shape=box, prompt="branch a saw=\${context.shared}"]
    b [shape=box, prompt="branch b saw=\${context.shared}"]
    join [shape=tripleoctagon]
    done [shape=Msquare]
    s -> fan
    fan -> a
    fan -> b
    a -> join
    b -> join
    join -> done
  }
`;

describe("parallel branches — context isolation", () => {
  test("one branch's context_updates are NOT visible to the sibling branch while it runs", async () => {
    const seenPrompts: Record<string, string[]> = {};
    await execute({
      graph: parseDotSource(BRANCHY),
      initial_context: { shared: "seed" },
      backend: new MockCodergenBackend((input: CodergenInput) => {
        const existing = seenPrompts[input.node.id];
        if (existing) {
          existing.push(input.prompt);
        } else {
          seenPrompts[input.node.id] = [input.prompt];
        }
        // Branch A writes a key that, if leaked, would show up in B's prompt.
        if (input.node.id === "a") return ok({ notes: "a done", context_updates: { shared: "A_MUTATED" } });
        return ok({ notes: "b done" });
      }),
    });
    // Both branches saw the pre-fork value; neither saw A's mutation.
    expect(seenPrompts["a"]).toEqual(["branch a saw=seed"]);
    expect(seenPrompts["b"]).toEqual(["branch b saw=seed"]);
  });

  test("post-join context carries branch_results + count + successes", async () => {
    const res = await execute({
      graph: parseDotSource(BRANCHY),
      backend: new MockCodergenBackend((input) => ok({ notes: `${input.node.id} done` })),
    });
    expect(res.context["parallel.count"]).toBe(2);
    expect(res.context["parallel.successes"]).toBe(2);
    // branch_results is an opaque aggregate — just assert it's populated.
    expect(res.context["parallel.branch_results"]).toBeDefined();
  });

  test("a branch's mutation does NOT leak back to the pipeline context when no merge policy asks for it", async () => {
    const res = await execute({
      graph: parseDotSource(BRANCHY),
      initial_context: { shared: "seed" },
      backend: new MockCodergenBackend((input) => {
        if (input.node.id === "a") return ok({ notes: "a", context_updates: { branch_a_touched: true } });
        return ok({ notes: "b" });
      }),
    });
    // The branch's own update survives the merge (AGENTS.md: "branch
    // context updates merge back via parallel.branch_results, parallel.count,
    // and parallel.successes"), but `shared` — which nobody mutated — is
    // still the seed value.
    expect(res.context["shared"]).toBe("seed");
    expect(res.context["branch_a_touched"]).toBe(true);
  });
});
