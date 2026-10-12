// `ReadPlane.snapshotRef` — the one read behind the snapshot tree / file
// endpoints. Every refusal the route turns into a status comes from here, so
// the route body carries no store read of its own.

import { describe, expect, test } from "bun:test";
import type { IEventStore, StoredEvent } from "@fragua/store";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

const SNAPSHOT: StoredEvent = {
  runId: "r1",
  seq: 12,
  type: "snapshot.captured",
  writer: "daemon",
  payload: { nodeId: "work", label: "after work", commitSha: "c".repeat(40), treeSha: "t".repeat(40) },
  ts: 1,
};

function fakeStore(cwd: string | null): IEventStore {
  return {
    getState: (runId: string) => (runId === "r1" ? { runId, cwd } : null),
    getSnapshotEvents: (runId: string) => (runId === "r1" ? [SNAPSHOT] : []),
  } as unknown as IEventStore;
}

describe("readPlane.snapshotRef", () => {
  test("resolves a snapshot to its commit and worktree", () => {
    const plane = makeReadPlane({ store: fakeStore("/w/r1") });
    expect(plane.snapshotRef("r1", 12)).toEqual({ ok: true, cwd: "/w/r1", commitSha: "c".repeat(40) });
  });

  test("refuses an absent run, a run with no worktree, and an unknown eventIdx", () => {
    expect(makeReadPlane({ store: fakeStore("/w/r1") }).snapshotRef("nope", 12)).toEqual({
      ok: false,
      reason: "run_not_found",
    });
    expect(makeReadPlane({ store: fakeStore(null) }).snapshotRef("r1", 12)).toEqual({
      ok: false,
      reason: "no_worktree",
    });
    expect(makeReadPlane({ store: fakeStore("/w/r1") }).snapshotRef("r1", 13)).toEqual({
      ok: false,
      reason: "snapshot_not_found",
    });
  });
});
