// Adversarial: cancel and interview.timeout race.
//
// If a cancel is in flight while the interviewer is about to resolve with
// `{value: "TIMEOUT"}`, the terminal pipeline event must be
// `pipeline.canceled` (cancel wins — it was the user's intent). We do NOT
// want a `pipeline.failed` with "human gate timed out" masking the cancel.

import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import type { ControlRequest } from "../../src/types/events.ts";
import type { Answer, Interviewer, Question } from "../../src/types/interviewer.ts";

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

/** Interviewer that resolves with TIMEOUT after a delay, unless aborted first. */
class TimingOutInterviewer implements Interviewer {
  constructor(private readonly delayMs: number) {}

  async ask(_question: Question): Promise<Answer> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { value: "TIMEOUT" };
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  inform(_message: string, _stage: string): void {}
}

describe("execute — cancel races interview.timeout", () => {
  test("cancel arriving before TIMEOUT resolves ⇒ pipeline.canceled (not failed)", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        gate [shape=hexagon, prompt="Approve?"]
        done [shape=Msquare]
        s -> gate -> done
      }
    `);

    const { push, tail } = makeControlChannel();
    const sink = new InMemorySink();
    const iv = new TimingOutInterviewer(50);

    // Cancel as soon as the interview starts but well before the 50ms
    // TIMEOUT elapses — so the abort path wins the race.
    const cancelWhenInterviewing = (async () => {
      for (let i = 0; i < 400; i++) {
        if (sink.byType("interview.started").length > 0) {
          push(req("c1", "cancel"));
          return;
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();

    const res = await execute({
      graph,
      sink,
      interviewer: iv,
      controlChannel: { path: "/dev/null", tail },
    });
    await cancelWhenInterviewing;

    expect(sink.byType("pipeline.canceled").length).toBe(1);
    expect(sink.byType("pipeline.failed").length).toBe(0);
    expect(sink.byType("interview.timeout").length).toBe(0);
    expect(res.outcome.failure_reason).toContain("canceled");
  });
});
