// Property-based fuzz of the control channel.
//
// Strategy: generate a random schedule of control requests (pause, resume,
// cancel, steer — with random ids, random interleaving) and fire them at
// a running pipeline at random-ish moments. Assert the invariants that
// must hold regardless of the schedule:
//
//   1. Exactly one terminal pipeline.* event is emitted.
//   2. pipeline.started is the first event.
//   3. If any cancel was applied, the terminal is pipeline.canceled.
//   4. Every control.requested has exactly one matching applied or rejected.
//   5. No control.applied fires after the terminal event.
//   6. Every node.started has a matching completed or failed.
//   7. The executor always completes (no hangs).
//
// Shrinking is free via fast-check so any counterexample comes back
// minimised.

import { describe, test } from "bun:test";
import fc from "fast-check";
import { InMemorySink } from "../../src/events/sink.ts";
import { type CodergenBackend, type CodergenInput, execute } from "../../src/executor/execute.ts";
import { parseDotSource } from "../../src/parser/parser.ts";
import type { ControlRequest } from "../../src/types/events.ts";
import { ok, type Outcome } from "../../src/types/outcome.ts";

/** Seedable PRNG so fast-check shrinking is deterministic. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

type Cmd = "pause" | "resume" | "cancel" | "steer";

/** Arbitrary for a schedule: a list of (command, delayMs) pairs.
 * Small delays so the whole property test finishes quickly. */
const scheduleArb = fc.array(
  fc.tuple(
    fc.constantFrom<Cmd>("pause", "resume", "cancel", "steer"),
    fc.integer({ min: 0, max: 30 }),
  ),
  { minLength: 0, maxLength: 6 },
);

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

class SteerableMockBackend implements CodergenBackend {
  constructor(private readonly delayMs: number) {}
  async run(input: CodergenInput): Promise<Outcome> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return ok({ notes: `ran ${input.node.id}` });
  }
  steer(_: string): void {}
}

async function runOne(schedule: Array<[Cmd, number]>, seed: number): Promise<string | null> {
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

  const rand = mulberry32(seed);
  const { push, tail } = makeControlChannel();
  const sink = new InMemorySink();
  // Slow nodes a bit so control requests can realistically land mid-run.
  const backend = new SteerableMockBackend(3);

  const driver = (async () => {
    let n = 0;
    for (const [cmd, delay] of schedule) {
      await new Promise((r) => setTimeout(r, delay));
      const id = `${cmd}-${n++}-${Math.floor(rand() * 1e6)}`;
      const req: ControlRequest =
        cmd === "steer"
          ? { id, timestamp: "2026-04-19T00:00:00Z", command: cmd, payload: { message: `msg-${n}` } }
          : { id, timestamp: "2026-04-19T00:00:00Z", command: cmd };
      push(req);
    }
  })();

  const execPromise = execute({
    graph,
    sink,
    backend,
    controlChannel: { path: "/dev/null", tail },
  });

  // A pause without a later resume/cancel is valid — the executor is
  // designed to gate forever. To keep the property test bounded we fire
  // a fallback cancel after a generous window. This is the "something
  // goes wrong, shut it down" path every real deployment eventually
  // exercises. A true hang (cancel doesn't unwind) is caught below.
  const fallbackCancel = (async () => {
    await new Promise((r) => setTimeout(r, 400));
    push({ id: `fallback-cancel`, timestamp: "2026-04-19T00:00:00Z", command: "cancel" });
  })();

  const hardTimeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000));
  const result = await Promise.race([execPromise, hardTimeout]);
  await driver;
  await fallbackCancel;

  if (result === "timeout") {
    return `executor hung on schedule ${JSON.stringify(schedule)} (cancel did not unwind)`;
  }

  const events = sink.snapshot();

  // Invariant 1: exactly one terminal event
  const terminals = events.filter(
    (e) => e.type === "pipeline.completed" || e.type === "pipeline.failed" || e.type === "pipeline.canceled",
  );
  if (terminals.length !== 1) {
    return `expected exactly 1 terminal event, got ${terminals.length} (${terminals.map((t) => t.type).join(",")})`;
  }
  const terminal = terminals[0]!;

  // Invariant 2: pipeline.started is first
  if (events[0]?.type !== "pipeline.started") {
    return `first event is ${events[0]?.type}, expected pipeline.started`;
  }

  // Invariant 3: if any cancel was applied, terminal is canceled
  const cancelApplied = events.some((e) => e.type === "control.applied" && e.data["command"] === "cancel");
  if (cancelApplied && terminal.type !== "pipeline.canceled") {
    return `cancel was applied but terminal is ${terminal.type}`;
  }

  // Invariant 4: every control.requested has a paired applied or rejected
  const requested = events.filter((e) => e.type === "control.requested");
  const acks = events.filter((e) => e.type === "control.applied" || e.type === "control.rejected");
  const ackIds = new Set(acks.map((e) => e.data["id"] as string));
  for (const r of requested) {
    const id = r.data["id"] as string;
    if (!ackIds.has(id)) return `control.requested id=${id} has no matching applied/rejected`;
  }

  // Invariant 5: no control.applied fires after the terminal
  const terminalIdx = events.indexOf(terminal);
  for (let i = terminalIdx + 1; i < events.length; i++) {
    if (events[i]!.type === "control.applied") {
      return `control.applied at idx ${i} fired after terminal at idx ${terminalIdx}`;
    }
  }

  // Invariant 6: node.started count == node terminal count
  const starts = events.filter((e) => e.type === "node.started").length;
  const ends = events.filter((e) => e.type === "node.completed" || e.type === "node.failed").length;
  if (starts !== ends) {
    return `node.started=${starts} but node terminals=${ends}`;
  }

  return null;
}

describe("simulation — random control-command schedule", () => {
  test("invariants hold across random schedules", async () => {
    await fc.assert(
      fc.asyncProperty(scheduleArb, fc.integer({ min: 1, max: 2 ** 30 }), async (schedule, seed) => {
        const violation = await runOne(schedule, seed);
        if (violation !== null) {
          throw new Error(violation);
        }
      }),
      { numRuns: 60, timeout: 10_000 },
    );
  }, 120_000);
});
