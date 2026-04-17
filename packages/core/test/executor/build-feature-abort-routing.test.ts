// Routing contract for workflows/build-feature.dot:
//
// When `explore` or `plan` emit a fail outcome (which the PiCodergenBackend
// produces on `<abort>…</abort>`), the run must terminate at `done` without
// forwarding to `implement_and_review`, `verify`, `update_docs`, `commit`,
// or `summarize`. Before this contract existed, a no-op / blocked plan would
// silently pass through the full pipeline and burn tokens on downstream
// nodes that had nothing to act on.
//
// The test injects a handler stub that emits a fail outcome on the chosen
// node and asserts no downstream node starts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, HANDLERS, type Handler, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

const BUILD_FEATURE = readFileSync(resolve(import.meta.dir, "../../../../workflows/build-feature.dot"), "utf8");

function graph() {
  return parseDotSource(BUILD_FEATURE);
}

/** Overlay a per-node `codergen` stub onto the default handler registry so
 * non-`box` shapes (trapezium loop, etc.) still resolve. */
function codergenPerNode(
  byId: Record<string, () => Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>>,
): Record<string, Handler> {
  const codergen: Handler = async (ctx) => {
    const fn = byId[ctx.node.id];
    if (!fn) return ok({ notes: `stub:${ctx.node.id}` });
    return fn();
  };
  return { ...HANDLERS, codergen };
}

function nodesThatRan(events: { type: string; node_id?: string }[]): string[] {
  return events
    .filter((e) => e.type === "node.started")
    .map((e) => e.node_id!)
    .filter(Boolean);
}

describe("build-feature.dot — early abort routing", () => {
  test("plan → fail routes straight to done; implement_and_review never starts", async () => {
    const sink = new InMemorySink();
    await execute({
      graph: graph(),
      sink,
      handlers: codergenPerNode({
        explore: async () => ok({ notes: "explore ok" }),
        plan: async () => fail("cannot plan: missing $ARGUMENTS", { non_retryable: true }),
      }),
      backend: new MockCodergenBackend(() => ok({ notes: "unused" })),
    });
    const ran = nodesThatRan(sink.snapshot());
    expect(ran).toContain("start");
    expect(ran).toContain("explore");
    expect(ran).toContain("plan");
    expect(ran).toContain("done");
    // The whole point of the contract: none of these must have run.
    expect(ran).not.toContain("implement_and_review");
    expect(ran).not.toContain("verify");
    expect(ran).not.toContain("update_docs");
    expect(ran).not.toContain("commit");
    expect(ran).not.toContain("summarize");
  });

  test("explore → fail routes straight to done; plan never starts", async () => {
    const sink = new InMemorySink();
    await execute({
      graph: graph(),
      sink,
      handlers: codergenPerNode({
        explore: async () => fail("cannot explore: missing $ARGUMENTS", { non_retryable: true }),
      }),
      backend: new MockCodergenBackend(() => ok({ notes: "unused" })),
    });
    const ran = nodesThatRan(sink.snapshot());
    expect(ran).toContain("explore");
    expect(ran).toContain("done");
    expect(ran).not.toContain("plan");
    expect(ran).not.toContain("implement_and_review");
  });

  test("success path is unchanged — on `ok` outcomes the unconditional edges still fire", async () => {
    // We only need to prove that explore → plan → implement_and_review fires
    // when both explore and plan return success. We truncate the run at
    // implement_and_review's first iteration (which returns APPROVED) by
    // having the verify stub abort — so we don't have to simulate CI loops
    // or goal-gate retries inside a unit test.
    const sink = new InMemorySink();
    await execute({
      graph: graph(),
      sink,
      handlers: codergenPerNode({
        explore: async () => ok({ notes: "explore ok" }),
        plan: async () => ok({ notes: "<promise>PLAN_READY</promise>" }),
        verify: async () => fail("aborted for test brevity", { non_retryable: true }),
      }),
      backend: new MockCodergenBackend((input) =>
        ok({ notes: input.node.id === "implement_and_review" ? "<promise>APPROVED</promise>" : "ok" }),
      ),
    });
    const ran = nodesThatRan(sink.snapshot());
    // The key claim: all three pre-verify nodes run exactly because the
    // conditional `outcome=fail` edge does NOT match a success outcome.
    expect(ran).toContain("explore");
    expect(ran).toContain("plan");
    expect(ran).toContain("implement_and_review");
  });
});
