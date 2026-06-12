// `ReadPlane.eventsTail` — the bounded event-log read backing the CLI's
// `runs events` / `runs tail`. The plane adds only the absent-run guard;
// the bound itself is the store's (SQL-level), so a partial fake suffices.

import { describe, expect, test } from "bun:test";
import type { GetEventsTailOpts, IEventStore, StoredEvent } from "@fragua/store";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

const EVENTS: StoredEvent[] = [
  { runId: "r1", seq: 8, type: "llm.start", writer: "daemon", payload: {}, ts: 1 },
  { runId: "r1", seq: 9, type: "llm.done", writer: "daemon", payload: {}, ts: 2 },
];

function fakeStore(): { store: IEventStore; calls: Array<{ runId: string; opts: GetEventsTailOpts }> } {
  const calls: Array<{ runId: string; opts: GetEventsTailOpts }> = [];
  const store = {
    getState: (runId: string) => (runId === "r1" ? { runId } : null),
    getEventsTail: (runId: string, opts: GetEventsTailOpts = {}) => {
      calls.push({ runId, opts });
      return EVENTS;
    },
  } as unknown as IEventStore;
  return { store, calls };
}

describe("readPlane.eventsTail", () => {
  test("null for absent run, bounded slice for present run", () => {
    const { store, calls } = fakeStore();
    const plane = makeReadPlane({ store });

    expect(plane.eventsTail("nope", { limit: 3 })).toBeNull();
    expect(calls).toEqual([]); // absent-run guard short-circuits before the store read

    const got = plane.eventsTail("r1", { sinceSeq: 7, typePrefix: "llm.", limit: 3 });
    expect(got).toEqual(EVENTS); // store rows pass through untransformed
    expect(calls).toEqual([{ runId: "r1", opts: { sinceSeq: 7, typePrefix: "llm.", limit: 3 } }]);
  });
});
