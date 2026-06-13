// `ReadPlane.fleetSummary` — the fleet rollup backing `fragua runs ls
// --summary`. The plane is a pure pass-through (the aggregation is the
// store's SQL), so a partial fake pins the seam: opts go down untouched,
// the summary comes back untransformed.

import { describe, expect, test } from "bun:test";
import type { FleetSummary, FleetSummaryOpts, IEventStore } from "@fragua/store";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

const SUMMARY: FleetSummary = {
  statusCounts: {
    queued: 1,
    running: 2,
    paused: 0,
    paused_human: 1,
    paused_auto: 0,
    completed: 3,
    cancelled: 0,
    halted: 1,
    quarantined: 0,
  },
  workflows: [{ workflow: "alpha", running: 2, done: 3, failed: 1, total: 6 }],
  inFlightCostUsd: 0.42,
  totalRuns: 8,
};

function fakeStore(): { store: IEventStore; calls: FleetSummaryOpts[] } {
  const calls: FleetSummaryOpts[] = [];
  const store = {
    fleetSummary: (opts: FleetSummaryOpts = {}) => {
      calls.push(opts);
      return SUMMARY;
    },
  } as unknown as IEventStore;
  return { store, calls };
}

describe("readPlane.fleetSummary", () => {
  test("threads the scope opts to the store and returns the aggregation untransformed", () => {
    const { store, calls } = fakeStore();
    const plane = makeReadPlane({ store });

    const got = plane.fleetSummary({ cwd: "/repos/proj", statuses: ["running"], limit: 20 });
    expect(got).toEqual(SUMMARY);
    expect(calls).toEqual([{ cwd: "/repos/proj", statuses: ["running"], limit: 20 }]);
  });

  test("defaults to an empty opts object when called bare", () => {
    const { store, calls } = fakeStore();
    const plane = makeReadPlane({ store });
    plane.fleetSummary();
    expect(calls).toEqual([{}]);
  });
});
