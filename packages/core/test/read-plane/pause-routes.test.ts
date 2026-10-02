// `ReadPlane.pauseRoutes` — the bounded control-surface read that recovers a
// paused run's declared route enum. The store returns one row (the latest
// human pause); the plane only narrows the payload, so a partial fake suffices.

import { describe, expect, test } from "bun:test";
import type { IEventStore, StoredEvent } from "@fragua/store";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

function fakeStore(latest: StoredEvent | null): IEventStore {
  return {
    getLatestHumanPause: () => latest,
  } as unknown as IEventStore;
}

describe("readPlane.pauseRoutes", () => {
  test("null when the run never paused at a human node", () => {
    const plane = makeReadPlane({ store: fakeStore(null) });
    expect(plane.pauseRoutes("r1")).toBeNull();
  });

  test("returns the v4 pause's nodeId and route enum", () => {
    const ev: StoredEvent = {
      runId: "r1",
      seq: 5,
      type: "fact.run_paused",
      writer: "daemon",
      payload: { reason: "human", nodeId: "ask", text: "?", routes: ["approve", "reject"] },
      ts: 1,
    };
    const plane = makeReadPlane({ store: fakeStore(ev) });
    expect(plane.pauseRoutes("r1")).toEqual({ nodeId: "ask", routes: ["approve", "reject"] });
  });

  test("folds the LEGACY fact.run_paused_human shape", () => {
    const ev: StoredEvent = {
      runId: "r1",
      seq: 5,
      type: "fact.run_paused_human",
      writer: "daemon",
      payload: { nodeId: "ask", text: "?", routes: ["a", "b"] },
      ts: 1,
    };
    const plane = makeReadPlane({ store: fakeStore(ev) });
    expect(plane.pauseRoutes("r1")).toEqual({ nodeId: "ask", routes: ["a", "b"] });
  });

  test("empty routes and no nodeId project defensively", () => {
    const ev: StoredEvent = {
      runId: "r1",
      seq: 5,
      type: "fact.run_paused",
      writer: "daemon",
      payload: { reason: "human", routes: [1, "keep", null] },
      ts: 1,
    };
    const plane = makeReadPlane({ store: fakeStore(ev) });
    expect(plane.pauseRoutes("r1")).toEqual({ routes: ["keep"] });
  });
});
