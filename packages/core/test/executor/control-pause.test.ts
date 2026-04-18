// Pause / resume via the control channel.
//
// Soft-pause semantics: a pause request does NOT interrupt the running
// node; the scheduler gates at the next boundary (after `node.completed`
// fires) and `control.applied` lands at that moment. Resume wakes the
// waiter and the pipeline finishes normally.
//
// The control tail is injected as a pluggable `tail` function, so these
// tests use an in-memory queue rather than `tailControlRequests` + a
// temp file — we want deterministic timing for the pause-then-resume
// dance without sleeping.

import { describe, expect, test } from "bun:test";
import type { ControlRequest } from "../../src/types/events.ts";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute, MockCodergenBackend } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import { ok } from "../../src/types/outcome.ts";

/** Build a controllable async iterator of ControlRequests that can be
 * driven from test code. Returns a `push` function + a `tail` factory
 * compatible with `ExecuteOptions.controlChannel.tail`. */
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

describe("execute — control.pause / control.resume", () => {
  test("pause before first node gates the scheduler; resume lets the run finish", async () => {
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

    // Pre-seed a pause request before execution starts; the control loop
    // reads it on startup and the first boundary (after `s` completes)
    // gates. We must fire `resume` from a side channel to unblock.
    push(req("pause-1", "pause"));

    // Watch the sink for `control.applied(pause)` and fire resume as soon
    // as it lands. This exercises the real two-phase contract.
    const resumeWhenPauseApplied = (async () => {
      for (let i = 0; i < 200; i++) {
        const applied = sink.byType("control.applied").find((e) => e.data["command"] === "pause");
        if (applied) {
          push(req("resume-1", "resume"));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const res = await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });
    await resumeWhenPauseApplied;

    expect(res.outcome.status).toBe("success");
    expect(res.completed_nodes).toEqual(["s", "a", "b", "done"]);

    const requested = sink.byType("control.requested");
    const applied = sink.byType("control.applied");

    expect(requested.map((e) => e.data["id"])).toEqual(["pause-1", "resume-1"]);

    const pauseApplied = applied.find((e) => e.data["command"] === "pause");
    const resumeApplied = applied.find((e) => e.data["command"] === "resume");
    expect(pauseApplied).toBeDefined();
    expect(pauseApplied!.data["applied_at_node"]).toBe("s");
    expect(resumeApplied).toBeDefined();
  });

  test("resume without a prior pause is rejected with not_paused", async () => {
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] a [prompt="a"] done [shape=Msquare] s -> a -> done }
    `);
    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();

    push(req("resume-stray", "resume"));

    const res = await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });

    expect(res.outcome.status).toBe("success");
    const rejected = sink.byType("control.rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]!.data["id"]).toBe("resume-stray");
    expect(rejected[0]!.data["reason"]).toBe("not_paused");
  });

  test("a second pause while already paused is idempotent (applied with note)", async () => {
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] a [prompt="a"] done [shape=Msquare] s -> a -> done }
    `);
    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();

    push(req("pause-1", "pause"));
    push(req("pause-2", "pause"));

    const resumeWhenDouble = (async () => {
      for (let i = 0; i < 400; i++) {
        const pauseAcks = sink.byType("control.applied").filter((e) => e.data["command"] === "pause");
        if (pauseAcks.length >= 2) {
          push(req("resume-1", "resume"));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const res = await execute({
      graph,
      sink,
      backend: new MockCodergenBackend(() => ok({ notes: "ok" })),
      controlChannel: { path: "/dev/null", tail },
    });
    await resumeWhenDouble;

    expect(res.outcome.status).toBe("success");
    const applied = sink.byType("control.applied");
    const pauseAcks = applied.filter((e) => e.data["command"] === "pause");
    expect(pauseAcks.length).toBe(2);
    const second = pauseAcks.find((e) => e.data["id"] === "pause-2");
    expect(second).toBeDefined();
    expect(second!.data["note"]).toBe("already_paused");
  });
});
