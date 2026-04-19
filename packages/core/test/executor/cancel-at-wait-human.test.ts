// Adversarial: cancel arrives while the pipeline is blocked on a `wait.human`
// gate (Interviewer.ask hasn't returned yet).
//
// Expected contract: the control.cancel trips the executor's signal, the
// interviewer call unwinds, and the run terminates as `pipeline.canceled` —
// not left hanging on an `interview.started` without a matching terminal.

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

/** Interviewer whose `ask` never resolves on its own — only a signal abort
 * can unwind it. Mirrors a real human sitting on the prompt indefinitely. */
class HangingInterviewer implements Interviewer {
  started = 0;
  aborted = 0;

  async ask(_question: Question, opts?: { signal?: AbortSignal }): Promise<Answer> {
    this.started++;
    const signal = opts?.signal;
    if (!signal) {
      return new Promise<Answer>(() => {});
    }
    return new Promise<Answer>((_, reject) => {
      const onAbort = () => {
        this.aborted++;
        reject(new Error("aborted"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  inform(_message: string, _stage: string): void {}
}

describe("execute — cancel at wait.human boundary", () => {
  test("cancel while interviewer is blocked unwinds to pipeline.canceled", async () => {
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
    const iv = new HangingInterviewer();

    // Fire cancel once we see interview.started, so we know the handler
    // is actually inside ask() and not just pre-emit.
    const cancelOnInterview = (async () => {
      for (let i = 0; i < 400; i++) {
        if (sink.byType("interview.started").length > 0) {
          push(req("c1", "cancel", { reason: "user walked away" }));
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const res = await execute({
      graph,
      sink,
      interviewer: iv,
      controlChannel: { path: "/dev/null", tail },
    });
    await cancelOnInterview;

    expect(sink.byType("interview.started").length).toBe(1);
    const canceled = sink.byType("pipeline.canceled");
    expect(canceled.length).toBe(1);
    expect(canceled[0]!.data["request_id"]).toBe("c1");
    expect(sink.byType("pipeline.completed").length).toBe(0);
    expect(sink.byType("pipeline.failed").length).toBe(0);
    expect(res.outcome.status).toBe("fail");
    expect(res.outcome.failure_reason).toContain("canceled");
  });
});
