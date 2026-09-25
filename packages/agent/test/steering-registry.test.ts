// SteeringRegistry — per-run live-agent + steer-buffer semantics.
//
// Fixed-example tests pin the contract that concurrent runs on a shared
// backend never leak messages across runId boundaries. See the sibling
// `steering-registry.property.test.ts` for the invariant-level PBT.

import { describe, expect, test } from "bun:test";
import { MAX_BUFFERED_STEERS, type SteerableAgent, SteeringRegistry } from "../src/steering-registry.ts";

class FakeAgent implements SteerableAgent {
  readonly received: string[] = [];
  steer(msg: { content: [{ type: "text"; text: string }] }): void {
    this.received.push(msg.content[0]?.text ?? "");
  }
}

describe("SteeringRegistry — basics", () => {
  test("steer with no active agent buffers under the runId", () => {
    const reg = new SteeringRegistry();
    reg.steer("r1", "hello");

    expect(reg.hasActive("r1")).toBe(false);
    expect(reg.pendingCount("r1")).toBe(1);
    expect(reg.pendingCount("r2")).toBe(0);
  });

  test("beginRun drains buffered messages into the agent in FIFO order", () => {
    const reg = new SteeringRegistry();
    reg.steer("r1", "first");
    reg.steer("r1", "second");
    reg.steer("r1", "third");

    const a = new FakeAgent();
    reg.beginRun("r1", a);

    expect(a.received).toEqual(["first", "second", "third"]);
    // The buffer SURVIVES the drain: a sibling branch of the same fan-out
    // registers a moment later and must receive the same messages. It clears
    // when the last agent leaves, not when the first one arrives.
    expect(reg.pendingCount("r1")).toBe(3);
    reg.endRun("r1", a);
    expect(reg.pendingCount("r1")).toBe(0);
  });

  test("steer with an active agent injects immediately", () => {
    const reg = new SteeringRegistry();
    const a = new FakeAgent();
    reg.beginRun("r1", a);

    reg.steer("r1", "live");
    expect(a.received).toEqual(["live"]);
  });

  test("steer broadcasts to every live agent registered for the run", () => {
    // The fan-out regression: five concurrent llm branches under one runId.
    // A mid-flight steer must reach all of them, not just the last to begin.
    const reg = new SteeringRegistry();
    const branches = [new FakeAgent(), new FakeAgent(), new FakeAgent(), new FakeAgent(), new FakeAgent()];
    branches.forEach((a, i) => {
      reg.beginRun("fo", a, { nodeId: `lens${i}`, iteration: 0 });
    });

    reg.steer("fo", "tighten the scope");

    for (const a of branches) expect(a.received).toEqual(["tighten the scope"]);
    expect(reg.activeCount("fo")).toBe(5);
  });

  test("steer returns a delivered outcome listing each branch's node and iteration", () => {
    const reg = new SteeringRegistry();
    reg.beginRun("fo", new FakeAgent(), { nodeId: "adversarial", iteration: 0 });
    reg.beginRun("fo", new FakeAgent(), { nodeId: "scope", iteration: 1 });

    const delivery = reg.steer("fo", "go");

    expect(delivery.disposition).toBe("delivered");
    expect(delivery.targets).toEqual([
      { nodeId: "adversarial", iteration: 0 },
      { nodeId: "scope", iteration: 1 },
    ]);
  });

  test("steer with no live agent returns a buffered outcome", () => {
    const reg = new SteeringRegistry();
    const delivery = reg.steer("r1", "later");
    expect(delivery).toEqual({ disposition: "buffered", targets: [] });
  });

  test("endRun removes only the ending agent; a surviving sibling still receives steers", () => {
    const reg = new SteeringRegistry();
    const a1 = new FakeAgent();
    const a2 = new FakeAgent();
    reg.beginRun("fo", a1, { nodeId: "b1", iteration: 0 });
    reg.beginRun("fo", a2, { nodeId: "b2", iteration: 0 });

    reg.endRun("fo", a1);
    expect(reg.activeCount("fo")).toBe(1);

    reg.steer("fo", "still going");
    expect(a1.received).toEqual([]);
    expect(a2.received).toEqual(["still going"]);
  });

  test("endRun clears the slot only when the agent matches", () => {
    const reg = new SteeringRegistry();
    const a1 = new FakeAgent();
    const a2 = new FakeAgent();

    reg.beginRun("r1", a1);
    // Hostile end call with the wrong agent — slot stays put.
    reg.endRun("r1", a2);
    expect(reg.hasActive("r1")).toBe(true);

    reg.endRun("r1", a1);
    expect(reg.hasActive("r1")).toBe(false);
  });

  test("empty-string steers are dropped", () => {
    const reg = new SteeringRegistry();
    reg.steer("r1", "");
    expect(reg.pendingCount("r1")).toBe(0);

    const a = new FakeAgent();
    reg.beginRun("r1", a);
    reg.steer("r1", "");
    expect(a.received).toEqual([]);
  });
});

describe("SteeringRegistry — isolation across runs", () => {
  test("steer for run A never lands on agent B", () => {
    const reg = new SteeringRegistry();
    const aA = new FakeAgent();
    const aB = new FakeAgent();

    reg.beginRun("runA", aA);
    reg.beginRun("runB", aB);

    reg.steer("runA", "for A");
    reg.steer("runB", "for B");

    expect(aA.received).toEqual(["for A"]);
    expect(aB.received).toEqual(["for B"]);
  });

  test("ending run A does not clear run B's slot", () => {
    const reg = new SteeringRegistry();
    const aA = new FakeAgent();
    const aB = new FakeAgent();

    reg.beginRun("runA", aA);
    reg.beginRun("runB", aB);
    reg.endRun("runA", aA);

    expect(reg.hasActive("runA")).toBe(false);
    expect(reg.hasActive("runB")).toBe(true);

    // Run B's agent still receives its own steer.
    reg.steer("runB", "B still alive");
    expect(aB.received).toEqual(["B still alive"]);
  });

  test("buffered steers for run A do not drain into run B's agent", () => {
    const reg = new SteeringRegistry();
    reg.steer("runA", "A buffered 1");
    reg.steer("runA", "A buffered 2");
    reg.steer("runB", "B buffered");

    const aB = new FakeAgent();
    reg.beginRun("runB", aB);

    expect(aB.received).toEqual(["B buffered"]);
    expect(reg.pendingCount("runA")).toBe(2);
  });

  test("forgetRun drops both slots for that run and leaves others intact", () => {
    const reg = new SteeringRegistry();
    const aA = new FakeAgent();
    const aB = new FakeAgent();

    reg.beginRun("runA", aA);
    reg.beginRun("runB", aB);
    reg.steer("runA", "live-A"); // goes to aA immediately
    reg.steer("runC", "buffered-C");

    reg.forgetRun("runA");
    reg.forgetRun("runC");

    expect(reg.hasActive("runA")).toBe(false);
    expect(reg.pendingCount("runA")).toBe(0);
    expect(reg.pendingCount("runC")).toBe(0);
    expect(reg.hasActive("runB")).toBe(true);

    // A new run using a previously-forgotten runId starts fresh.
    reg.steer("runA", "new buffer");
    expect(reg.pendingCount("runA")).toBe(1);
  });
});

describe("buffered steers under fan-out (the dispatch race)", () => {
  // A steer only lands in the buffer when a handler is dispatched but its
  // agent has not registered yet — the fold owns every other case
  // (docs/intent-fold.md). Under `parallel` that window holds N racing
  // branches, so the buffer must not be consumed by whichever one wins.
  test("every branch registering before the set empties receives the buffer", () => {
    const r = new SteeringRegistry();
    const a1 = new FakeAgent();
    const a2 = new FakeAgent();
    const a3 = new FakeAgent();

    expect(r.steer("run", "focus on the cache").disposition).toBe("buffered");

    r.beginRun("run", a1, { nodeId: "b1", iteration: 0 });
    r.beginRun("run", a2, { nodeId: "b2", iteration: 0 });
    r.beginRun("run", a3, { nodeId: "b3", iteration: 0 });

    expect(a1.received).toEqual(["focus on the cache"]);
    expect(a2.received).toEqual(["focus on the cache"]);
    expect(a3.received).toEqual(["focus on the cache"]);
  });

  test("the buffer clears when the last branch leaves, so the next node starts clean", () => {
    const r = new SteeringRegistry();
    const b1 = new FakeAgent();
    const b2 = new FakeAgent();
    r.steer("run", "old steer");
    r.beginRun("run", b1, { nodeId: "b1", iteration: 0 });
    r.beginRun("run", b2, { nodeId: "b2", iteration: 0 });
    r.endRun("run", b1);
    expect(r.pendingCount("run")).toBe(1); // b2 still live — interval open
    r.endRun("run", b2);
    expect(r.pendingCount("run")).toBe(0); // interval closed

    const next = new FakeAgent();
    r.beginRun("run", next, { nodeId: "n2", iteration: 0 });
    expect(next.received).toEqual([]);
  });

  test("a branch that re-registers mid-interval is not injected twice", () => {
    const r = new SteeringRegistry();
    const b1 = new FakeAgent();
    const b2 = new FakeAgent();
    r.steer("run", "once");
    r.beginRun("run", b1, { nodeId: "b1", iteration: 0 });
    r.beginRun("run", b2, { nodeId: "b2", iteration: 0 });
    r.endRun("run", b1); // b2 keeps the interval open
    r.beginRun("run", b1, { nodeId: "b1", iteration: 1 });
    expect(b1.received).toEqual(["once"]);
  });

  test("the buffer is capped, keeping the newest", () => {
    const r = new SteeringRegistry();
    for (let i = 0; i < MAX_BUFFERED_STEERS + 10; i++) r.steer("run", `m${i}`);
    expect(r.pendingCount("run")).toBe(MAX_BUFFERED_STEERS);
    const a = new FakeAgent();
    r.beginRun("run", a, { nodeId: "b", iteration: 0 });
    expect(a.received[0]).toBe("m10");
    expect(a.received.at(-1)).toBe(`m${MAX_BUFFERED_STEERS + 9}`);
  });
});
