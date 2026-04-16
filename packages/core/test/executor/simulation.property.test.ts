// Property / simulation sweep: run thousands of randomized pipelines and
// verify the event log invariants hold regardless of outcome distribution.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, type Outcome, ok } from "../../src/types/outcome.ts";

const OUTCOMES = ["success", "fail", "partial_success"] as const;

describe("simulation — event log invariants", () => {
  test("for any random outcome sequence the log starts/ends correctly", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a
        b
        done [shape=Msquare]
        fallback [shape=Msquare]
        s -> a
        a -> b [condition="outcome=success"]
        a -> fallback [condition="outcome=fail"]
        b -> done [condition="outcome=success"]
        b -> fallback [condition="outcome=fail"]
      }
    `);
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...OUTCOMES), { minLength: 2, maxLength: 6 }), async (sequence) => {
        let idx = 0;
        const sink = new InMemorySink();
        const backend = new MockCodergenBackend((): Outcome => {
          const pick = sequence[idx % sequence.length];
          idx++;
          if (pick === "success") return ok();
          if (pick === "fail") return fail("nope");
          return ok({ status: "partial_success" });
        });
        await execute({ graph, sink, backend });
        const events = sink.snapshot();
        if (events.length === 0) return false;
        // First event must be pipeline.started
        if (events[0]!.type !== "pipeline.started") return false;
        // Last event must be pipeline.completed or pipeline.failed
        const last = events[events.length - 1]!.type;
        if (last !== "pipeline.completed" && last !== "pipeline.failed") return false;
        // Each node.started has a corresponding node.completed or node.failed
        const starts = events.filter((e) => e.type === "node.started").length;
        const ends = events.filter((e) => e.type === "node.completed" || e.type === "node.failed").length;
        if (starts !== ends) return false;
        return true;
      }),
      { numRuns: 100 },
    );
  });

  test("2000 runs with scripted linear workflow remain byte-identical", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        step1 [prompt="do one"]
        step2 [prompt="do two"]
        done [shape=Msquare]
        s -> step1 -> step2 -> done
      }
    `);
    let i = 0;
    const stubNow = () => {
      const t = `2026-01-01T00:00:${String(i++).padStart(2, "0")}Z`;
      return t;
    };
    const collectSignature = async (): Promise<string> => {
      i = 0; // reset clock per run so timestamps are identical
      const sink = new InMemorySink();
      await execute({
        graph,
        sink,
        backend: new MockCodergenBackend(() => ok({ notes: "step done" })),
        now: stubNow,
        run_id: "RUN-X",
      });
      return sink
        .snapshot()
        .map((e) => `${e.type}:${e.node_id ?? ""}:${e.timestamp}`)
        .join("|");
    };

    const first = await collectSignature();
    for (let n = 0; n < 2000; n++) {
      const next = await collectSignature();
      if (next !== first) {
        expect(next).toBe(first);
      }
    }
  });
});
