// Cancel via the control channel.
//
// Contract: `control.cancel` trips the executor's AbortController, in-flight
// work unwinds via signal checks, and `pipeline.canceled` is emitted as the
// terminal event (instead of `pipeline.failed` / `pipeline.completed`). The
// request id is echoed on `pipeline.canceled.data.request_id` so consumers
// can correlate without replaying the control stream.

import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import type { ControlRequest } from "../../src/types/events.ts";
import { ok } from "../../src/types/outcome.ts";

function makeControlChannel(): {
  push: (r: ControlRequest) => void;
  tail: (path: string, opts: { signal: AbortSignal }) => AsyncIterable<ControlRequest>;
} {
  const queue: ControlRequest[] = [];
  let notify: (() => void) | undefined;
  const push = (r: ControlRequest) => {
    queue.push(r);
    notify?.();
    notify = undefined;
  };
  const tail = async function* (_path: string, opts: { signal: AbortSignal }): AsyncIterable<ControlRequest> {
    while (!opts.signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  return { push, tail };
}

function req(id: string, command: ControlRequest["command"], payload?: ControlRequest["payload"]): ControlRequest {
  return {
    id,
    timestamp: "2026-04-17T00:00:00Z",
    command,
    ...(payload !== undefined ? { payload } : {}),
  };
}

describe("execute — control.cancel", () => {
  test("cancel trips the signal; pipeline.canceled is emitted with the request id", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [prompt="a"]
        b [prompt="b"]
        done [shape=Msquare]
        s -> a -> b -> done
      }
    `);

    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();
    push(req("cancel-1", "cancel", { reason: "user aborted" }));

    const res = await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });

    const canceled = sink.byType("pipeline.canceled");
    expect(canceled.length).toBe(1);
    expect(canceled[0]!.data["cause"]).toBe("control.cancel");
    expect(canceled[0]!.data["request_id"]).toBe("cancel-1");
    expect(canceled[0]!.data["reason"]).toBe("user aborted");
    expect(sink.byType("pipeline.completed").length).toBe(0);
    expect(sink.byType("pipeline.failed").length).toBe(0);
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason).toContain("canceled");
  });

  test("cancel while paused wakes the boundary and emits pipeline.canceled", async () => {
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] a [prompt="a"] done [shape=Msquare] s -> a -> done }
    `);
    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();

    push(req("p1", "pause"));

    // Fire cancel as soon as pause has landed. This exercises the path
    // where cancel has to wake a resume-waiter.
    const cancelWhenPaused = (async () => {
      for (let i = 0; i < 400; i++) {
        const applied = sink.byType("control.applied").find((e) => e.data["command"] === "pause");
        if (applied) {
          push(req("c1", "cancel"));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });
    await cancelWhenPaused;

    expect(sink.byType("pipeline.canceled").length).toBe(1);
    expect(sink.byType("pipeline.canceled")[0]!.data["request_id"]).toBe("c1");
  });

  test("a second cancel is rejected with already_terminal", async () => {
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] a [prompt="a"] done [shape=Msquare] s -> a -> done }
    `);
    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();
    push(req("c1", "cancel"));
    push(req("c2", "cancel"));

    await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });

    const applied = sink.byType("control.applied").filter((e) => e.data["command"] === "cancel");
    const rejected = sink.byType("control.rejected").filter((e) => e.data["command"] === "cancel");
    expect(applied.map((e) => e.data["id"])).toEqual(["c1"]);
    expect(rejected.map((e) => e.data["id"])).toEqual(["c2"]);
    expect(rejected[0]!.data["reason"]).toBe("already_terminal");
  });
});
