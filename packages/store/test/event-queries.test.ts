// Unit tests for the per-parent descendant SSE cursor queries
// (`getEventsForRunWithDescendantsForward` /
// `getEventsForRunWithDescendantsAtFloor`).
//
// The recursive CTE + strict-tuple cursor mirror the global feed's
// shape, but scoped to a parent run's tree via `run_state.parent_run_id`.
// These tests pin (a) descendant rows are included, (b) unrelated runs
// are not, (c) pagination is monotonic across same-ts batches, and
// (d) the boundary rescan returns new lex-smaller `(run_id, seq)`
// inserts at the floor ts.
//
// docs/proposals/descendant-event-stream.md.

import { describe, expect, test } from "bun:test";
import type { ObservabilityEvent } from "../src/index.ts";
import { SqliteStore } from "../src/index.ts";

function newStore(now: () => number): SqliteStore {
  const s = new SqliteStore({ path: ":memory:", now });
  s.saveWorkflow("wf", "t", "digraph {}");
  return s;
}

function obs(type: string): ObservabilityEvent {
  return { type, payload: { nodeId: "n", iteration: 0 } } as ObservabilityEvent;
}

/** Seed parent + N descendant child runs. Each child carries
 *  `parent_run_id = parent` plus the required parallel-linkage tuple. */
function seedTree(s: SqliteStore, parentId: string, childIds: string[]): void {
  s.enqueueRun({ runId: parentId, workflowSha: "wf" });
  childIds.forEach((cid, i) => {
    s.enqueueRun({
      runId: cid,
      workflowSha: "wf",
      parentRunId: parentId,
      parentNodeId: "fan",
      parallelIndex: i,
      subgraphRootNodeId: "branch",
      subgraphTerminalNodeId: "branch_end",
    });
  });
}

describe("selectEventsForRunWithDescendantsForward", () => {
  test("returns parent + sub-run events in (ts, runId, seq) order", () => {
    let t = 1_000;
    const s = newStore(() => t);
    seedTree(s, "p", ["c1", "c2"]);

    // Cross-run ordering: bump the clock between batches so each batch
    // lands at a distinct ts. Within a batch every event shares one ts
    // and tie-breaks on (run_id, seq).
    t = 2_000;
    s.appendObservabilityEvents("p", [obs("agent.info")]);
    t = 2_500;
    s.appendObservabilityEvents("c1", [obs("agent.info")]);
    t = 3_000;
    s.appendObservabilityEvents("c2", [obs("agent.info")]);
    t = 3_500;
    s.appendObservabilityEvents("p", [obs("agent.info")]);

    const out = s.getEventsForRunWithDescendantsForward({
      parentRunId: "p",
      floorTs: 0,
      lastRunId: "",
      lastSeq: -1,
      limit: 100,
    });

    // Filter out the seed `intent.run_enqueued` rows (one per run at
    // their enqueue ts) — they vary in ts but are part of the tree.
    // The point of this assertion is the strict (ts, runId, seq) total
    // order across the merged stream.
    const obsRows = out.filter((e) => e.type === "agent.info");
    expect(obsRows.map((e) => `${e.ts}/${e.runId}`)).toEqual(["2000/p", "2500/c1", "3000/c2", "3500/p"]);
    s.close();
  });

  test("strict-tuple cursor `> (ts, runId, seq)` excludes the cursor row", () => {
    let t = 1_000;
    const s = newStore(() => t);
    seedTree(s, "p", ["c1"]);

    // Three events at the same ts, distinct (run_id, seq) tuples.
    t = 5_000;
    s.appendObservabilityEvents("p", [obs("agent.info")]);
    s.appendObservabilityEvents("c1", [obs("agent.info")]);
    s.appendObservabilityEvents("p", [obs("agent.info")]);

    // Place cursor at the c1 row — only the second p row should come
    // back from a strict-tuple scan at the same ts.
    const c1Row = s
      .getEventsForRunWithDescendantsForward({
        parentRunId: "p",
        floorTs: 5_000,
        lastRunId: "",
        lastSeq: -1,
        limit: 100,
      })
      .find((e) => e.runId === "c1" && e.type === "agent.info");
    expect(c1Row).toBeDefined();

    const after = s.getEventsForRunWithDescendantsForward({
      parentRunId: "p",
      floorTs: 5_000,
      lastRunId: c1Row!.runId,
      lastSeq: c1Row!.seq,
      limit: 100,
    });
    // "c1" lex-precedes "p", so after the c1 cursor everything from
    // "p" at the same ts is strictly greater — both p obs rows come
    // back. The strict-tuple cursor's job is to exclude the c1 row
    // itself, which it does.
    expect(after.every((e) => e.runId === "p")).toBe(true);
    expect(after.map((e) => `${e.runId}.${e.seq}`)).toContain("p.3");
    expect(after.some((e) => e.runId === "c1")).toBe(false);
    s.close();
  });

  test("LIMIT clips and pagination is monotonic across same-ts events", () => {
    let t = 1_000;
    const s = newStore(() => t);
    seedTree(s, "p", ["c1", "c2"]);

    // Three events at the same ts. With LIMIT 1 the forward cursor
    // walks them one at a time — pagination must terminate and the
    // collected order must match the (ts, runId, seq) total order.
    t = 7_000;
    s.appendObservabilityEvents("p", [obs("agent.info")]);
    s.appendObservabilityEvents("c1", [obs("agent.info")]);
    s.appendObservabilityEvents("c2", [obs("agent.info")]);

    const collected: string[] = [];
    let cur = { lastRunId: "", lastSeq: -1 };
    for (let i = 0; i < 6; i++) {
      const batch = s.getEventsForRunWithDescendantsForward({
        parentRunId: "p",
        floorTs: 7_000,
        lastRunId: cur.lastRunId,
        lastSeq: cur.lastSeq,
        limit: 1,
      });
      if (batch.length === 0) break;
      for (const ev of batch) {
        collected.push(ev.runId);
        cur = { lastRunId: ev.runId, lastSeq: ev.seq };
      }
    }
    // Lex on run_id: "c1" < "c2" < "p".
    expect(collected).toEqual(["c1", "c2", "p"]);
    s.close();
  });

  test("ignores events on unrelated (non-descendant) runs", () => {
    let t = 1_000;
    const s = newStore(() => t);
    seedTree(s, "p", ["c1"]);
    // Separate top-level run; NOT linked to "p".
    s.enqueueRun({ runId: "other", workflowSha: "wf" });

    t = 9_000;
    s.appendObservabilityEvents("p", [obs("agent.info")]);
    s.appendObservabilityEvents("c1", [obs("agent.info")]);
    s.appendObservabilityEvents("other", [obs("agent.info")]);

    const out = s.getEventsForRunWithDescendantsForward({
      parentRunId: "p",
      floorTs: 8_500,
      lastRunId: "",
      lastSeq: -1,
      limit: 100,
    });

    const runIds = new Set(out.map((e) => e.runId));
    expect(runIds.has("p")).toBe(true);
    expect(runIds.has("c1")).toBe(true);
    expect(runIds.has("other")).toBe(false);
    s.close();
  });
});

describe("selectEventsForRunWithDescendantsAtFloor", () => {
  test("returns same-ts events with (runId, seq) > cursor", () => {
    let t = 1_000;
    const s = newStore(() => t);
    seedTree(s, "p", ["c1", "c2"]);

    // Three same-ts events; the floor-rescan walks them ASC. With
    // cursor at (c1, c1.seq) only c2 and p (lex-greater) come back.
    t = 11_000;
    s.appendObservabilityEvents("p", [obs("agent.info")]);
    s.appendObservabilityEvents("c1", [obs("agent.info")]);
    s.appendObservabilityEvents("c2", [obs("agent.info")]);

    const all = s.getEventsForRunWithDescendantsAtFloor({
      parentRunId: "p",
      floorTs: 11_000,
      afterRunId: "",
      afterSeq: -1,
      limit: 100,
    });
    const obsRows = all.filter((e) => e.type === "agent.info");
    expect(obsRows.map((e) => e.runId)).toEqual(["c1", "c2", "p"]);

    const c1 = obsRows.find((e) => e.runId === "c1")!;
    const after = s
      .getEventsForRunWithDescendantsAtFloor({
        parentRunId: "p",
        floorTs: 11_000,
        afterRunId: c1.runId,
        afterSeq: c1.seq,
        limit: 100,
      })
      .filter((e) => e.type === "agent.info");
    expect(after.map((e) => e.runId)).toEqual(["c2", "p"]);
    s.close();
  });
});
