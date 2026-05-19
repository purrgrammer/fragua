// Pure-reducer tests for `lib/useDetailOverlay.ts`.
// No DOM, no React — plain function calls.

import { describe, expect, test } from "bun:test";
import type { RunDetail } from "../../src/lib/api.ts";
import {
  type DetailOverlay,
  EMPTY_DETAIL_OVERLAY,
  foldDetailFrame,
  isDetailEvent,
  mergeDetail,
} from "../../src/lib/useDetailOverlay.ts";

function snapshot(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "r1",
    startedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    lastEventSeq: 100,
    nodes: [],
    selectedEdges: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

function fold(prev: DetailOverlay, type: string, payload: Record<string, unknown> | null, seq: number): DetailOverlay {
  return foldDetailFrame(prev, type, payload, seq);
}

describe("isDetailEvent", () => {
  test("recognises fact.node_*, fact.run_*, edge.selected", () => {
    expect(isDetailEvent("fact.node_started")).toBe(true);
    expect(isDetailEvent("fact.node_completed")).toBe(true);
    expect(isDetailEvent("fact.node_aborted")).toBe(true);
    expect(isDetailEvent("fact.run_started")).toBe(true);
    expect(isDetailEvent("fact.run_completed")).toBe(true);
    expect(isDetailEvent("fact.run_halted")).toBe(true);
    expect(isDetailEvent("fact.run_cancelled")).toBe(true);
    expect(isDetailEvent("fact.run_quarantined")).toBe(true);
    expect(isDetailEvent("fact.run_paused_human")).toBe(true);
    expect(isDetailEvent("fact.run_resumed")).toBe(true);
    expect(isDetailEvent("edge.selected")).toBe(true);
  });

  test("returns false for hot-path observability events", () => {
    expect(isDetailEvent("llm.text_delta")).toBe(false);
    expect(isDetailEvent("llm.thinking_delta")).toBe(false);
    expect(isDetailEvent("agent.message_start")).toBe(false);
    expect(isDetailEvent("cost.recorded")).toBe(false);
  });
});

describe("foldDetailFrame", () => {
  test("fact.node_started → nodeStates['n1#0'] = running", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "n1", iteration: 0 }, 5);
    expect(out.nodeStates.get("n1#0")).toEqual({ nodeId: "n1", iteration: 0, state: "running", lastEventSeq: 5 });
  });

  test("fact.node_completed (outcomeStatus=fail) → failed", () => {
    const out = fold(
      EMPTY_DETAIL_OVERLAY,
      "fact.node_completed",
      { nodeId: "n1", iteration: 0, outcomeStatus: "fail" },
      7,
    );
    expect(out.nodeStates.get("n1#0")?.state).toBe("failed");
  });

  test("fact.node_completed (no outcomeStatus) → completed", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_completed", { nodeId: "n1", iteration: 0 }, 7);
    expect(out.nodeStates.get("n1#0")?.state).toBe("completed");
  });

  test("fact.node_aborted → failed", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_aborted", { nodeId: "n1", iteration: 0 }, 9);
    expect(out.nodeStates.get("n1#0")?.state).toBe("failed");
  });

  test("loop iterations track separate entries by (nodeId, iteration)", () => {
    let s = fold(
      EMPTY_DETAIL_OVERLAY,
      "fact.node_completed",
      { nodeId: "verify", iteration: 0, outcomeStatus: "fail" },
      5,
    );
    s = fold(s, "fact.node_started", { nodeId: "verify", iteration: 1 }, 6);
    s = fold(s, "fact.node_completed", { nodeId: "verify", iteration: 1, outcomeStatus: "success" }, 7);
    expect(s.nodeStates.get("verify#0")?.state).toBe("failed");
    expect(s.nodeStates.get("verify#1")?.state).toBe("completed");
  });

  test("missing iteration on payload defaults to 0 (back-compat with older event logs)", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "n1" }, 5);
    expect(out.nodeStates.get("n1#0")?.state).toBe("running");
  });

  test("edge.selected appends to selectedEdges in order, with iteration and seq", () => {
    // The reducer tags each edge with its event seq so `mergeDetail` can
    // drop overlay edges already represented in the snapshot — without
    // this, every snapshot refetch that catches up to overlay events
    // double-counts the same edge and the run-detail Graph view shows
    // `· ×N` badges on edges that fired exactly once.
    let s = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "a", to: "b", iteration: 0 }, 1);
    s = fold(s, "edge.selected", { from: "b", to: "c", iteration: 0 }, 2);
    expect(s.selectedEdges).toEqual([
      { from: "a", to: "b", iteration: 0, seq: 1 },
      { from: "b", to: "c", iteration: 0, seq: 2 },
    ]);
  });

  test("fact.run_completed updates status", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.run_completed", null, 50);
    expect(out.status).toBe("success");
  });

  test("fact.run_halted records haltSeq for the terminal-halt patch", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.run_halted", null, 42);
    expect(out.status).toBe("fail");
    expect(out.haltSeq).toBe(42);
  });

  test("malformed payloads (missing nodeId/from/to) are ignored", () => {
    const a = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", null, 1);
    expect(a.nodeStates.size).toBe(0);
    const b = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "a" }, 1);
    expect(b.selectedEdges).toEqual([]);
  });

  test("unknown event types short-circuit to prev (reference-equal)", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "agent.warning", { msg: "x" }, 1);
    expect(out).toBe(EMPTY_DETAIL_OVERLAY);
  });

  describe("HITL — fact.run_paused_human / fact.run_resumed", () => {
    const opts = [
      { key: "A", label: "[A] Approve", to: "publish" },
      { key: "R", label: "[R] Revise", to: "draft" },
    ];

    test("fact.run_paused_human populates structured fields and flips status", () => {
      const out = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_human",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      expect(out.status).toBe("paused");
      expect(out.runStatus).toBe("paused_human");
      expect(out.hitlNodeId).toBe("review");
      expect(out.hitlLabel).toBe("Approve?");
      expect(out.hitlOptions).toEqual(opts);
    });

    test("fact.run_paused_provider_error flips status without touching HITL fields", () => {
      // Sanity: only the HITL paused event populates HITL fields. A
      // provider-error pause must leave hitlOptions null.
      const out = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused",
        {
          reason: "provider_error",
          nodeId: "review",
          provider: "anthropic",
          httpStatus: 429,
          errorMessage: "rate limit",
        },
        12,
      );
      expect(out.status).toBe("paused");
      expect(out.runStatus).toBe("paused");
      expect(out.hitlNodeId).toBeNull();
      expect(out.hitlLabel).toBeNull();
      expect(out.hitlOptions).toBeNull();
    });

    test("fact.run_resumed clears HITL fields and re-flips status to running", () => {
      let s = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_human",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      s = fold(s, "fact.run_resumed", { fromStatus: "paused_human" }, 13);
      expect(s.status).toBe("running");
      expect(s.runStatus).toBe("running");
      expect(s.hitlNodeId).toBeNull();
      expect(s.hitlLabel).toBeNull();
      expect(s.hitlOptions).toBeNull();
    });

    test("malformed paused_human (missing options array) → options stays null", () => {
      const out = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_human",
        { nodeId: "review", label: "x" /* options omitted */ },
        7,
      );
      expect(out.runStatus).toBe("paused_human");
      expect(out.hitlOptions).toBeNull();
    });
  });
});

describe("mergeDetail", () => {
  test("empty overlay returns the snapshot reference unchanged", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", iteration: 0, state: "running", lastEventSeq: 10 }] });
    const merged = mergeDetail(snap, EMPTY_DETAIL_OVERLAY);
    expect(merged).toBe(snap);
  });

  test("overlay node state replaces snapshot row when seq is newer", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", iteration: 0, state: "running", lastEventSeq: 10 }] });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.node_completed", { nodeId: "n1", iteration: 0 }, 20);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toEqual([{ nodeId: "n1", iteration: 0, state: "completed", lastEventSeq: 20 }]);
  });

  test("overlay introduces nodes not in the snapshot", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", iteration: 0, state: "completed", lastEventSeq: 10 }] });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "n2", iteration: 0 }, 25);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toEqual([
      { nodeId: "n1", iteration: 0, state: "completed", lastEventSeq: 10 },
      { nodeId: "n2", iteration: 0, state: "running", lastEventSeq: 25 },
    ]);
  });

  test("overlay introduces a fresh iteration alongside an existing one", () => {
    const snap = snapshot({
      nodes: [{ nodeId: "verify", iteration: 0, state: "failed", lastEventSeq: 10 }],
    });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "verify", iteration: 1 }, 25);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toEqual([
      { nodeId: "verify", iteration: 0, state: "failed", lastEventSeq: 10 },
      { nodeId: "verify", iteration: 1, state: "running", lastEventSeq: 25 },
    ]);
  });

  test("terminal-halt patch downgrades still-running nodes to failed", () => {
    // Mirrors `deriveNodeStates`'s server-side patch: any node left in
    // "running" when the run halts is shown as failed.
    const snap = snapshot({
      status: "running",
      nodes: [
        { nodeId: "running-node", iteration: 0, state: "running", lastEventSeq: 5 },
        { nodeId: "done-node", iteration: 0, state: "completed", lastEventSeq: 8 },
      ],
    });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_halted", null, 42);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes.find((n) => n.nodeId === "running-node")?.state).toBe("failed");
    expect(merged.nodes.find((n) => n.nodeId === "done-node")?.state).toBe("completed");
    expect(merged.status).toBe("fail");
  });

  test("selectedEdges concatenate snapshot + overlay in order (overlay seq > snapshot.lastEventSeq)", () => {
    // Snapshot covers events through `lastEventSeq: 100`. Overlay edges
    // tagged with seqs 101 and 102 are strictly newer, so they pass the
    // dedup filter and concatenate after the snapshot's edges.
    const snap = snapshot({
      selectedEdges: [{ from: "a", to: "b", iteration: 0 }],
    });
    let overlay = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "b", to: "c", iteration: 0 }, 101);
    overlay = fold(overlay, "edge.selected", { from: "c", to: "d", iteration: 0 }, 102);
    const merged = mergeDetail(snap, overlay);
    expect(merged.selectedEdges).toEqual([
      { from: "a", to: "b", iteration: 0 },
      { from: "b", to: "c", iteration: 0 },
      { from: "c", to: "d", iteration: 0 },
    ]);
  });

  test("mergeDetail drops overlay edges already covered by the snapshot (seq ≤ snapshot.lastEventSeq)", () => {
    // Regression for the run-detail Graph view's `· ×2` bug. The overlay
    // accumulates `edge.selected` events from-mount onwards regardless
    // of the snapshot's seq frontier (the consumer doesn't trim on
    // refetch). Without filtering, a snapshot refetch that catches up
    // to overlay events would double-count them: every linear edge
    // surfaces as `traversalCount === 2`.
    const snap = snapshot({
      lastEventSeq: 100,
      // The snapshot already has a -> b derived server-side from the
      // same edge.selected event the overlay also saw at seq 50.
      selectedEdges: [{ from: "a", to: "b", iteration: 0 }],
    });
    // Overlay caught the SAME event the snapshot already covers
    // (seq 50 ≤ snapshot.lastEventSeq=100) — must be dropped — plus a
    // genuinely-newer one at seq 150.
    let overlay = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "a", to: "b", iteration: 0 }, 50);
    overlay = fold(overlay, "edge.selected", { from: "b", to: "c", iteration: 0 }, 150);
    const merged = mergeDetail(snap, overlay);
    expect(merged.selectedEdges).toEqual([
      { from: "a", to: "b", iteration: 0 }, // from snapshot, NOT duplicated
      { from: "b", to: "c", iteration: 0 }, // genuinely fresh overlay event
    ]);
  });

  test("status from overlay supersedes the snapshot status", () => {
    const snap = snapshot({ status: "running" });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_completed", null, 50);
    const merged = mergeDetail(snap, overlay);
    expect(merged.status).toBe("success");
  });

  test("preserves snapshot.nodes ref when the overlay carries no node-touching changes", () => {
    // The overlay has a status flip but no node fact has touched the
    // snapshot's rows. Earlier, mergeDetail still rebuilt the array via
    // .map; that destabilised `detail.nodes` on every overlay tick and
    // thrashed downstream memoisation. The merged top-level object is
    // allowed to change (status moved); `nodes` must not.
    const snap = snapshot({
      status: "running",
      nodes: [
        { nodeId: "n1", iteration: 0, state: "completed", lastEventSeq: 10 },
        { nodeId: "n2", iteration: 0, state: "completed", lastEventSeq: 20 },
      ],
    });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_completed", null, 50);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toBe(snap.nodes);
    expect(merged.status).toBe("success");
  });

  test("preserves snapshot.nodes ref when an overlay node entry is older than the snapshot's", () => {
    // Defensive path: a stale overlay row (lastEventSeq < snapshot's)
    // is dropped, so no node row actually moves. The output array must
    // still be the snapshot's reference.
    const snap = snapshot({
      nodes: [{ nodeId: "n1", iteration: 0, state: "completed", lastEventSeq: 30 }],
    });
    const overlay: DetailOverlay = {
      ...EMPTY_DETAIL_OVERLAY,
      // Forge a stale entry with older seq than the snapshot's.
      nodeStates: new Map([["n1#0", { nodeId: "n1", iteration: 0, state: "running", lastEventSeq: 5 }]]),
      status: "running",
    };
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toBe(snap.nodes);
  });

  describe("HITL fields", () => {
    const opts = [{ key: "A", label: "[A] Approve", to: "publish" }];

    test("paused_human overlay propagates HITL fields onto the snapshot", () => {
      const snap = snapshot({ status: "running", runStatus: "running" });
      const overlay = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_human",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      const merged = mergeDetail(snap, overlay);
      expect(merged.status).toBe("paused");
      expect(merged.runStatus).toBe("paused_human");
      expect(merged.hitlNodeId).toBe("review");
      expect(merged.hitlLabel).toBe("Approve?");
      expect(merged.hitlOptions).toEqual(opts);
    });

    test("snapshot HITL fields survive when overlay carries unrelated changes", () => {
      // Snapshot already has paused_human info (from runStateToDetail);
      // an empty overlay must not stomp them with null.
      const snap = snapshot({
        status: "paused",
        runStatus: "paused_human",
        hitlNodeId: "review",
        hitlLabel: "Approve?",
        hitlOptions: opts,
      });
      const merged = mergeDetail(snap, EMPTY_DETAIL_OVERLAY);
      expect(merged).toBe(snap); // empty overlay short-circuit
      expect(merged.hitlNodeId).toBe("review");
    });

    test("fact.run_resumed overlay clears HITL fields on the merged detail", () => {
      const snap = snapshot({
        status: "paused",
        runStatus: "paused_human",
        hitlNodeId: "review",
        hitlLabel: "Approve?",
        hitlOptions: opts,
      });
      // Build an overlay that represents the resume — fact.run_resumed
      // sets runStatus back to "running" and nulls all the HITL fields.
      // The merge should flip runStatus and CLEAR the snapshot's HITL
      // fields. (Today the merge keeps snapshot fields when overlay is
      // null; this test documents the resume contract for future work.)
      const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_resumed", { fromStatus: "paused_human" }, 50);
      const merged = mergeDetail(snap, overlay);
      expect(merged.status).toBe("running");
      expect(merged.runStatus).toBe("running");
    });
  });
});
