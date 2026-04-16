import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import type { Event } from "../../src/types/events.ts";

function makeEvent(partial: Partial<Event>): Event {
  return {
    run_id: "r1",
    type: "node.started",
    timestamp: "2026-01-01T00:00:00Z",
    workflow_sha: "abc",
    data: {},
    ...partial,
  };
}

describe("InMemorySink", () => {
  test("append preserves order", async () => {
    const s = new InMemorySink();
    await s.append(makeEvent({ node_id: "a" }));
    await s.append(makeEvent({ node_id: "b" }));
    expect(s.snapshot().map((e) => e.node_id)).toEqual(["a", "b"]);
  });

  test("byType filters", async () => {
    const s = new InMemorySink();
    await s.append(makeEvent({ type: "node.started" }));
    await s.append(makeEvent({ type: "node.completed" }));
    expect(s.byType("node.completed")).toHaveLength(1);
  });

  test("byNode filters", async () => {
    const s = new InMemorySink();
    await s.append(makeEvent({ node_id: "x" }));
    await s.append(makeEvent({ node_id: "y" }));
    expect(s.byNode("x")).toHaveLength(1);
  });

  test("count + clear", async () => {
    const s = new InMemorySink();
    await s.append(makeEvent({}));
    expect(s.count()).toBe(1);
    s.clear();
    expect(s.count()).toBe(0);
  });
});
