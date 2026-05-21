// processOperatorActions — the daemon fold for post-terminal operator
// actions. The action (accept replay+stage / discard ref delete) already ran
// synchronously in the request path; the intent carries its result. This sweep
// is pure projection: intent.{accept,discard}_run → fact.run_{accepted,
// discarded}, advancing applied-seq in OCC lockstep. No git here.

import { describe, expect, test } from "bun:test";
import type { FactEvent, IEventStore, RunState, WakeCandidateRow } from "@fragua/store";
import type { IntentType } from "@fragua/types";
import { processOperatorActions } from "../src/operator-actions.ts";

interface FakeIntent {
  type: IntentType;
  seq: number;
  payload: unknown;
}

/** Minimal IEventStore exposing only the methods the sweep calls. Records
 * appended facts so assertions can inspect what the daemon emitted. */
function fakeStore(opts: { runId: string; state: Partial<RunState>; intents: FakeIntent[] }): {
  store: IEventStore;
  appended: Array<{ runId: string; fact: FactEvent; advanceAppliedTo: number | undefined }>;
} {
  const appended: Array<{ runId: string; fact: FactEvent; advanceAppliedTo: number | undefined }> = [];
  const candidate: WakeCandidateRow = { runId: opts.runId, version: 1, lastAppliedSeq: 0, status: "completed" };
  const state = {
    runId: opts.runId,
    status: "completed",
    inboxStatus: "pending",
    ...opts.state,
  } as unknown as RunState;

  const store = {
    getInboxActionCandidates: () => [candidate],
    getNextPendingIntent: (_runId: string, type: IntentType, since: number) => {
      const it = opts.intents.filter((i) => i.type === type && i.seq > since).sort((a, b) => a.seq - b.seq)[0];
      return it == null ? null : { seq: it.seq, payload: it.payload };
    },
    getState: (runId: string) => (runId === opts.runId ? state : null),
    appendFact: (runId: string, facts: FactEvent[], _v: number, o?: { advanceAppliedTo?: number }) => {
      for (const fact of facts) appended.push({ runId, fact, advanceAppliedTo: o?.advanceAppliedTo });
      return { seqs: facts.map((_, i) => i + 1), version: 2 };
    },
  } as unknown as IEventStore;

  return { store, appended };
}

describe("processOperatorActions", () => {
  test("accept: projects intent.accept_run → fact.run_accepted from the carried result", () => {
    const { store, appended } = fakeStore({
      runId: "run-a",
      state: {},
      intents: [{ type: "intent.accept_run", seq: 7, payload: { sha: "tip1", replayed: 2, tailStaged: true } }],
    });
    expect(processOperatorActions(store)).toEqual(["run-a"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.fact).toEqual({
      type: "fact.run_accepted",
      payload: { sha: "tip1", replayed: 2, tailStaged: true },
    });
    expect(appended[0]?.advanceAppliedTo).toBe(7);
  });

  test("discard: projects intent.discard_run → fact.run_discarded from the carried refs", () => {
    const refs = ["refs/fragua/heads/run-d", "refs/fragua/snapshots/run-d"];
    const { store, appended } = fakeStore({
      runId: "run-d",
      state: {},
      intents: [{ type: "intent.discard_run", seq: 4, payload: { refs } }],
    });
    expect(processOperatorActions(store)).toEqual(["run-d"]);
    expect(appended[0]?.fact).toEqual({ type: "fact.run_discarded", payload: { refs } });
    expect(appended[0]?.advanceAppliedTo).toBe(4);
  });

  test("lowest-seq intent applies first", () => {
    const { store, appended } = fakeStore({
      runId: "run-s",
      state: {},
      intents: [
        { type: "intent.discard_run", seq: 9, payload: { refs: [] } },
        { type: "intent.accept_run", seq: 3, payload: { sha: "x", replayed: 0, tailStaged: true } },
      ],
    });
    expect(processOperatorActions(store)).toEqual(["run-s"]);
    expect(appended[0]?.fact.type).toBe("fact.run_accepted"); // seq 3 before seq 9
    expect(appended[0]?.advanceAppliedTo).toBe(3);
  });

  test("discarded runs are skipped (terminal-terminal)", () => {
    const { store, appended } = fakeStore({
      runId: "run-x",
      state: { inboxStatus: "discarded" },
      intents: [{ type: "intent.accept_run", seq: 1, payload: { sha: "x", replayed: 0, tailStaged: true } }],
    });
    expect(processOperatorActions(store)).toEqual([]);
    expect(appended).toHaveLength(0);
  });
});
