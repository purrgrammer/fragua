// Phase 0 (docs/proposals/archive/bundles.md §2) — the keystone: a complete `run_state` is
// derivable by replaying the event log. The genesis `intent.run_enqueued` event
// now carries the whole enqueue identity, so `genesisToInitialState` + folding
// the facts (each at its own stored ts, exactly as `appendFact` applied it)
// reproduces the live projection — modulo the write-path bookkeeping the reducer
// doesn't own (version / seqs), the out-of-band `title`, and the local `cwd`
// binding (deliberately absent from the log → an imported run is inert).

import { describe, expect, test } from "bun:test";
import type { RunEnqueuedPayload } from "@fragua/types";
import { applyFact, type FactEvent, genesisToInitialState, newRunId, type RunState } from "../src/index.ts";
import { freshStore, seedWorkflow } from "./helpers.ts";

/** Replay an event log into a `run_state` the way import will: seed from the
 *  genesis event, then apply each fact at its recorded ts. */
function deriveFromLog(runId: string, events: { type: string; payload: unknown; ts: number }[]): RunState {
  const genesis = events.find((e) => e.type === "intent.run_enqueued");
  if (genesis == null) throw new Error("no genesis event");
  let state = genesisToInitialState(runId, genesis.payload as RunEnqueuedPayload, genesis.ts);
  for (const e of events) {
    if (e.type === "intent.run_enqueued" || !e.type.startsWith("fact.")) continue;
    state = applyFact(state, { type: e.type, payload: e.payload } as FactEvent, e.ts);
  }
  return state;
}

/** Fields the reducer doesn't own (write bookkeeping), plus the deliberately
 *  non-portable ones. Normalized away on both sides before comparing.
 *  `imported` is read-derived by `getState` (the `imported_runs` marker), not
 *  part of the reducer projection. */
function normalize(s: RunState): RunState {
  return { ...s, version: 0, nextSeq: 0, lastAppliedSeq: 0, title: null, cwd: null, imported: false };
}

describe("genesis derivation", () => {
  test("derived run_state == live getState (modulo bookkeeping/title/cwd)", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = newRunId();
    store.enqueueRun({
      runId,
      workflowSha: sha,
      priority: 7,
      cwd: "/home/dev/proj",
      projectId: "proj-id-1",
      projectName: "proj",
      workflowName: "wf",
      workflowScope: "local",
      workflowPath: "/home/dev/proj/.fragua/workflows/wf.yaml",
      initialRouting: { input: "do the thing" },
    });

    // Drive a realistic terminal run: started → snapshot → completed.
    let v = store.getState(runId)!.version;
    v = store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: sha, contractVersion: 1, startNode: "a", baseGitSha: "base-sha", baseGitRef: "main" },
        },
      ],
      v,
    ).newVersion;
    v = store.appendFact(
      runId,
      [
        {
          type: "fact.snapshot_recorded",
          payload: {
            eventIdx: 1,
            treeSha: "tree",
            commitSha: "commit",
            parentSnap: "base-sha",
            headSha: "head-sha",
            headRef: null,
            diffBaseSha: "base-sha",
            committed: null,
            uncommitted: { filesChanged: 2, insertions: 10, deletions: 1 },
          },
        },
      ],
      v,
    ).newVersion;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "a" } }], v);

    const live = store.getState(runId)!;
    const derived = deriveFromLog(runId, store.getEvents(runId));

    // The local binding is gone by construction; identity + folded state survive.
    expect(derived.cwd).toBeNull();
    expect(derived.projectId).toBe("proj-id-1");
    expect(derived.routing).toEqual({ input: "do the thing" });
    expect(derived.status).toBe("completed");
    expect(derived.baseGitSha).toBe("base-sha");
    expect(derived.diffBaseSha).toBe("base-sha");
    expect(derived.inboxStatus).toBe("pending");

    expect(normalize(derived)).toEqual(normalize(live));
    store.close();
  });

  test("enqueue rejects an over-cap genesis payload", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    expect(() =>
      store.enqueueRun({ runId: newRunId(), workflowSha: sha, initialRouting: { input: "x".repeat(5000) } }),
    ).toThrow();
    store.close();
  });
});
