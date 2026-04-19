// Adversarial: the full control-channel chain — pause, steer while paused,
// resume, then cancel mid-run. Confirms:
//   - steer reaches the backend even while the run is gated at a pause
//     boundary (no "paused ⇒ don't apply steer" assumption sneaks in),
//   - resume unblocks the boundary and the run advances,
//   - a subsequent cancel is honoured and produces pipeline.canceled.

import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { type CodergenBackend, type CodergenInput, execute } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import type { ControlRequest } from "../../src/types/events.ts";
import { ok, type Outcome } from "../../src/types/outcome.ts";

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
    timestamp: "2026-04-19T00:00:00Z",
    command,
    ...(payload !== undefined ? { payload } : {}),
  };
}

/** Backend that records steer messages and runs the given handler for run(). */
class SteerableMockBackend implements CodergenBackend {
  readonly steers: string[] = [];
  constructor(private readonly fn: (input: CodergenInput) => Outcome | Promise<Outcome>) {}
  async run(input: CodergenInput): Promise<Outcome> {
    return await this.fn(input);
  }
  steer(message: string): void {
    this.steers.push(message);
  }
}

describe("execute — pause → steer → resume → cancel", () => {
  test("steer applies while paused; resume runs; cancel terminates", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        a [prompt="a"]
        b [prompt="b"]
        c [prompt="c"]
        done [shape=Msquare]
        s -> a -> b -> c -> done
      }
    `);

    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();
    // Slow node `b` by ~100ms so the driver has time to inject a cancel
    // after `a` completes; other nodes run instantly.
    const backend = new SteerableMockBackend(async (input) => {
      if (input.node.id === "b") await new Promise((r) => setTimeout(r, 100));
      return ok({ notes: `ran ${input.node.id}` });
    });

    // Pre-seed pause; the first boundary (after `s` completes) gates.
    push(req("pause-1", "pause"));

    // After pause lands, push a steer (should apply while paused), then
    // resume, then cancel once the run advances past `a`.
    const driver = (async () => {
      // wait for pause to land
      for (let i = 0; i < 400; i++) {
        const applied = sink.byType("control.applied").find((e) => e.data["command"] === "pause");
        if (applied) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      push(req("steer-1", "steer", { message: "focus on tests" }));

      // wait for steer to be applied
      for (let i = 0; i < 400; i++) {
        const applied = sink.byType("control.applied").find((e) => e.data["command"] === "steer");
        if (applied) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      push(req("resume-1", "resume"));

      // wait for at least node `a` to complete post-resume, then cancel
      for (let i = 0; i < 400; i++) {
        const completed = sink.byType("node.completed").find((e) => e.node_id === "a");
        if (completed) {
          push(req("cancel-1", "cancel"));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const res = await execute({
      graph,
      sink,
      backend,
      controlChannel: { path: "/dev/null", tail },
    });
    await driver;

    // Steer was delivered to the backend while the run was paused.
    expect(backend.steers).toEqual(["focus on tests"]);

    // control.applied fired for all three non-cancel commands in order.
    const applied = sink.byType("control.applied").map((e) => ({
      id: e.data["id"] as string,
      cmd: e.data["command"] as string,
    }));
    const ids = applied.map((a) => a.id);
    expect(ids).toContain("pause-1");
    expect(ids).toContain("steer-1");
    expect(ids).toContain("resume-1");

    // Terminal event is pipeline.canceled.
    expect(sink.byType("pipeline.canceled").length).toBe(1);
    expect(sink.byType("pipeline.completed").length).toBe(0);
    expect(sink.byType("pipeline.failed").length).toBe(0);
    expect(res.outcome.failure_reason).toContain("canceled");
  });
});
