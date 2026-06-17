// Fold-contract canary — docs/proposals/archive/event-contract-version.md §3.3.
//
// The contract-surface hash (contract-version.test.ts) catches every STRUCTURAL
// change to the fold contract. It is blind to one residue: a reducer in
// reducers.ts that starts reading a previously-ignored payload field while the
// surface stays byte-identical — the fold changed, the hash did not. The
// reducers.ts touch-gate (scripts/check-contract-bump.sh) demands a human marker
// for that case, but the marker is self-service.
//
// This canary closes the loop behaviorally: it folds a fixed, representative
// event sequence to a baseline projection, then folds the SAME sequence with a
// synthetic NOVEL field (a name no current reducer reads) injected into every
// payload, and asserts the two projections are byte-for-byte identical. The
// moment a future reducer begins reading that field, the projections diverge and
// this test goes red — a behavioral change the surface hash cannot see is now
// caught by a test, no marker required.
//
// Both folds go through the REAL reducer path (`deriveRunState` / `foldFacts`),
// not a stub, so the canary reflects production fold semantics. The assertion
// rests only on reducer purity (same inputs ⇒ same projection): no clocks, no
// I/O — every event is folded at an explicit `ts`.

import { describe, expect, test } from "bun:test";
import type { RunEnqueuedPayload } from "@fragua/types";
import { deriveRunState, type FactEvent, foldFacts, genesisToInitialState, type RunState } from "../src/index.ts";

/** A field name no reducer reads today. If one starts, this canary diverges. */
const NOVEL_FIELD = "__fragua_canary_novel_field__";

/** The genesis `intent.run_enqueued` payload. `routing` is copied VERBATIM into
 * the projection (it's passthrough state, not a field a reducer interprets), so
 * the novel-field injection deliberately skips the routing subtree below. */
const GENESIS_PAYLOAD: RunEnqueuedPayload = {
  workflowSha: "wf-sha",
  priority: 3,
  projectId: "proj-id",
  projectName: "proj",
  routing: { "inputs.task": "do the thing" },
  contractVersion: 1,
  workflowName: "demo",
  workflowScope: "local",
  workflowPath: ".fragua/workflows/demo.yaml",
};

/** A fixed, representative timeline exercising as many reducer branches as one
 * run can: linear dispatch + completion, a HITL pause/resume, a fan-out region
 * (started → branch complete → branch abort → re-dispatch → complete → join), a
 * crash requeue carrying `lastAliveAt`, a terminal snapshot, accept, completion.
 * One non-fact (observability) event is interleaved to prove it's skipped. */
const TIMELINE: { seq: number; type: string; payload: unknown; ts: number }[] = [
  { seq: 0, type: "intent.run_enqueued", payload: GENESIS_PAYLOAD, ts: 100 },
  {
    seq: 1,
    type: "fact.run_started",
    payload: { workflowSha: "wf-sha", contractVersion: 1, startNode: "a", baseGitSha: "base", baseGitRef: "main" },
    ts: 200,
  },
  {
    seq: 2,
    type: "fact.node_completed",
    payload: {
      nodeId: "a",
      iteration: 0,
      tokens: 12,
      costUsd: 0.4,
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      inputCostUsd: 0.2,
      outputCostUsd: 0.15,
      cacheReadCostUsd: 0.03,
      cacheWriteCostUsd: 0.02,
      modelName: "claude",
      nextNode: "b",
    },
    ts: 300,
  },
  { seq: 3, type: "fact.node_started", payload: { nodeId: "b", iteration: 0 }, ts: 350 },
  { seq: 4, type: "fact.message_appended", payload: { role: "assistant", idx: 0 }, ts: 360 },
  {
    seq: 5,
    type: "fact.run_paused",
    payload: { reason: "human", nodeId: "b", text: "pick", routes: ["x", "y"] },
    ts: 400,
  },
  { seq: 6, type: "fact.run_resumed", payload: { fromStatus: "paused_human" }, ts: 900 },
  { seq: 7, type: "fact.dispatch_started", payload: { nodeId: "b", iteration: 0, resumeOf: "paused_human" }, ts: 950 },
  {
    seq: 8,
    type: "fact.node_completed",
    payload: { nodeId: "b", iteration: 0, tokens: 3, costUsd: 0.1, nextNode: "fan" },
    ts: 1000,
  },
  { seq: 9, type: "fact.fanout_started", payload: { nodeId: "fan", iteration: 0, branches: ["c", "d"] }, ts: 1100 },
  {
    seq: 10,
    type: "fact.node_completed",
    payload: { nodeId: "c", iteration: 0, tokens: 2, costUsd: 0.05, nextNode: "j" },
    ts: 1200,
  },
  {
    seq: 11,
    type: "fact.node_aborted",
    payload: { nodeId: "d", iteration: 0, cause: "timeout", partialTokens: 1, partialCostUsd: 0.01 },
    ts: 1300,
  },
  { seq: 12, type: "fact.dispatch_started", payload: { nodeId: "d", iteration: 0, resumeOf: "paused" }, ts: 1350 },
  {
    seq: 13,
    type: "fact.node_completed",
    payload: { nodeId: "d", iteration: 0, tokens: 4, costUsd: 0.08, nextNode: "j" },
    ts: 1400,
  },
  {
    seq: 14,
    type: "fact.fanout_joined",
    payload: { nodeId: "fan", iteration: 0, nextNode: "j", branchesCompleted: 2 },
    ts: 1500,
  },
  { seq: 15, type: "fact.run_requeued_after_crash", payload: { prevNode: "j", lastAliveAt: 1480 }, ts: 1600 },
  { seq: 16, type: "fact.dispatch_started", payload: { nodeId: "j", iteration: 0, resumeOf: "crash" }, ts: 1700 },
  {
    seq: 17,
    type: "fact.snapshot_recorded",
    payload: {
      eventIdx: 17,
      treeSha: "tree",
      commitSha: "commit",
      parentSnap: "parent",
      headSha: "head",
      headRef: null,
      diffBaseSha: "base",
      committed: { filesChanged: 2, insertions: 9, deletions: 3 },
      uncommitted: null,
    },
    ts: 1800,
  },
  { seq: 18, type: "fact.run_accepted", payload: { sha: "tip", replayed: 1, tailStaged: true }, ts: 1900 },
  { seq: 19, type: "fact.run_terminated", payload: { status: "completed", finalNode: "j" }, ts: 2000 },
];

/** Inject `NOVEL_FIELD` as a new TOP-LEVEL sibling key in each payload — exactly
 * how a reducer reads event data (`fact.payload.<field>`). Nested objects are
 * left untouched on purpose: a reducer that copies a nested object wholesale
 * (`routing`, a `changeStat` sub-record) is passing state THROUGH, not
 * interpreting a named field, so poisoning those subtrees would model a
 * different, legitimate behavior — not the silent-new-read residue this canary
 * guards. */
function injectNovel(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), [NOVEL_FIELD]: "canary" };
  }
  return payload;
}

function poisonedTimeline(): { seq: number; type: string; payload: unknown; ts: number }[] {
  return TIMELINE.map((e) => ({ ...e, payload: injectNovel(e.payload) }));
}

/** Facts only (drop the genesis intent + observability), for the `foldFacts` path. */
function factsOf(events: { type: string; payload: unknown }[]): FactEvent[] {
  return events
    .filter((e) => e.type.startsWith("fact."))
    .map((e) => ({ type: e.type, payload: e.payload }) as FactEvent);
}

describe("fold-contract canary: a novel payload field must not move the projection", () => {
  test("deriveRunState (full log fold) is byte-for-byte identical with the novel field injected", () => {
    const baseline = deriveRunState("r", TIMELINE);
    const poisoned = deriveRunState("r", poisonedTimeline());
    expect(JSON.stringify(poisoned)).toBe(JSON.stringify(baseline));
  });

  test("foldFacts (direct reducer path) is byte-for-byte identical with the novel field injected", () => {
    const seed = (): RunState => genesisToInitialState("r", GENESIS_PAYLOAD, 100);
    const baseline = foldFacts(seed(), factsOf(TIMELINE), 5000);
    const poisoned = foldFacts(seed(), factsOf(poisonedTimeline()), 5000);
    expect(JSON.stringify(poisoned)).toBe(JSON.stringify(baseline));
  });

  test("the injection is real: the poisoned payloads actually carry the novel field", () => {
    // Guards against a vacuous pass — if injection silently no-op'd, the
    // identity assertions above would be meaningless.
    const poisoned = poisonedTimeline();
    const started = poisoned.find((e) => e.type === "fact.run_started");
    expect((started?.payload as Record<string, unknown>)[NOVEL_FIELD]).toBe("canary");
    // …and the verbatim-copied routing subtree was deliberately left clean.
    const genesis = poisoned.find((e) => e.type === "intent.run_enqueued");
    const routing = (genesis?.payload as RunEnqueuedPayload).routing;
    expect(NOVEL_FIELD in routing).toBe(false);
  });
});
