import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { fail, ok } from "../../src/types/outcome.ts";

describe("retry backoff", () => {
  test("emits node.retrying events with attempt + delay_ms", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        flaky [max_retries=2]
        done [shape=Msquare]
        s -> flaky -> done
      }
    `);
    const sink = new InMemorySink();
    let calls = 0;
    await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => {
        calls++;
        return calls < 3 ? fail("not yet") : ok({ notes: "at last" });
      }),
      // deterministic random → jitter of 1.0
      random: () => 0.5,
    });
    const retries = sink.byType("node.retrying");
    expect(retries).toHaveLength(2);
    expect((retries[0]!.data as { attempt: number }).attempt).toBe(1);
    expect((retries[1]!.data as { attempt: number }).attempt).toBe(2);
    // base delay 500ms, then 1000ms with our jitter-1.0 stub
    expect((retries[0]!.data as { delay_ms: number }).delay_ms).toBe(500);
    expect((retries[1]!.data as { delay_ms: number }).delay_ms).toBe(1000);
  });

  test("backoff uses random() for jitter so tests can pin the value", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        n [max_retries=1]
        done [shape=Msquare]
        s -> n -> done
      }
    `);
    const sink = new InMemorySink();
    await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => fail("nope")),
      // random=0 → jitter = 1 + (0 - 0.5) = 0.5 → 500ms * 0.5 = 250ms
      random: () => 0,
    });
    const retries = sink.byType("node.retrying");
    expect((retries[0]!.data as { delay_ms: number }).delay_ms).toBe(250);
  });
});
