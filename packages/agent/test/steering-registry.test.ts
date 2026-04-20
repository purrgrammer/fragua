// SteeringRegistry — per-run live-agent + steer-buffer semantics.
//
// Fixed-example tests pin the contract that concurrent runs on a shared
// backend never leak messages across runId boundaries. See the sibling
// `steering-registry.property.test.ts` for the invariant-level PBT.

import { describe, expect, test } from "bun:test";
import { type SteerableAgent, SteeringRegistry } from "../src/steering-registry.ts";

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
    expect(reg.pendingCount("r1")).toBe(0);
  });

  test("steer with an active agent injects immediately", () => {
    const reg = new SteeringRegistry();
    const a = new FakeAgent();
    reg.beginRun("r1", a);

    reg.steer("r1", "live");
    expect(a.received).toEqual(["live"]);
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
