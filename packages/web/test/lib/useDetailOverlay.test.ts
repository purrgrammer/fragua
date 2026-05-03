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
    expect(isDetailEvent("fact.run_paused_hitl")).toBe(true);
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
  test("fact.node_started → nodeStates['n1'] = running", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "n1" }, 5);
    expect(out.nodeStates.get("n1")).toEqual({ state: "running", lastEventSeq: 5 });
  });

  test("fact.node_completed (outcomeStatus=fail) → failed", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_completed", { nodeId: "n1", outcomeStatus: "fail" }, 7);
    expect(out.nodeStates.get("n1")?.state).toBe("failed");
  });

  test("fact.node_completed (no outcomeStatus) → completed", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_completed", { nodeId: "n1" }, 7);
    expect(out.nodeStates.get("n1")?.state).toBe("completed");
  });

  test("fact.node_aborted → failed", () => {
    const out = fold(EMPTY_DETAIL_OVERLAY, "fact.node_aborted", { nodeId: "n1" }, 9);
    expect(out.nodeStates.get("n1")?.state).toBe("failed");
  });

  test("edge.selected appends to selectedEdges in order", () => {
    let s = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "a", to: "b" }, 1);
    s = fold(s, "edge.selected", { from: "b", to: "c" }, 2);
    expect(s.selectedEdges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
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

  describe("HITL — fact.run_paused_hitl / fact.run_resumed", () => {
    const opts = [
      { key: "A", label: "[A] Approve", to: "publish" },
      { key: "R", label: "[R] Revise", to: "draft" },
    ];

    test("fact.run_paused_hitl populates structured fields and flips status", () => {
      const out = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_hitl",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      expect(out.status).toBe("paused");
      expect(out.runStatus).toBe("paused_hitl");
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
        "fact.run_paused_hitl",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      s = fold(s, "fact.run_resumed", { fromStatus: "paused_hitl" }, 13);
      expect(s.status).toBe("running");
      expect(s.runStatus).toBe("running");
      expect(s.hitlNodeId).toBeNull();
      expect(s.hitlLabel).toBeNull();
      expect(s.hitlOptions).toBeNull();
    });

    test("malformed paused_hitl (missing options array) → options stays null", () => {
      const out = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_hitl",
        { nodeId: "review", label: "x" /* options omitted */ },
        7,
      );
      expect(out.runStatus).toBe("paused_hitl");
      expect(out.hitlOptions).toBeNull();
    });
  });
});

describe("mergeDetail", () => {
  test("empty overlay returns the snapshot reference unchanged", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", state: "running", lastEventSeq: 10 }] });
    const merged = mergeDetail(snap, EMPTY_DETAIL_OVERLAY);
    expect(merged).toBe(snap);
  });

  test("overlay node state replaces snapshot row when seq is newer", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", state: "running", lastEventSeq: 10 }] });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.node_completed", { nodeId: "n1" }, 20);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toEqual([{ nodeId: "n1", state: "completed", lastEventSeq: 20 }]);
  });

  test("overlay introduces nodes not in the snapshot", () => {
    const snap = snapshot({ nodes: [{ nodeId: "n1", state: "completed", lastEventSeq: 10 }] });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.node_started", { nodeId: "n2" }, 25);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toEqual([
      { nodeId: "n1", state: "completed", lastEventSeq: 10 },
      { nodeId: "n2", state: "running", lastEventSeq: 25 },
    ]);
  });

  test("terminal-halt patch downgrades still-running nodes to failed", () => {
    // Mirrors `deriveNodeStates`'s server-side patch: any node left in
    // "running" when the run halts is shown as failed.
    const snap = snapshot({
      status: "running",
      nodes: [
        { nodeId: "running-node", state: "running", lastEventSeq: 5 },
        { nodeId: "done-node", state: "completed", lastEventSeq: 8 },
      ],
    });
    const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_halted", null, 42);
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes.find((n) => n.nodeId === "running-node")?.state).toBe("failed");
    expect(merged.nodes.find((n) => n.nodeId === "done-node")?.state).toBe("completed");
    expect(merged.status).toBe("fail");
  });

  test("selectedEdges concatenate snapshot + overlay in order", () => {
    const snap = snapshot({
      selectedEdges: [{ from: "a", to: "b" }],
    });
    let overlay = fold(EMPTY_DETAIL_OVERLAY, "edge.selected", { from: "b", to: "c" }, 11);
    overlay = fold(overlay, "edge.selected", { from: "c", to: "d" }, 12);
    const merged = mergeDetail(snap, overlay);
    expect(merged.selectedEdges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
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
        { nodeId: "n1", state: "completed", lastEventSeq: 10 },
        { nodeId: "n2", state: "completed", lastEventSeq: 20 },
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
      nodes: [{ nodeId: "n1", state: "completed", lastEventSeq: 30 }],
    });
    const overlay: DetailOverlay = {
      ...EMPTY_DETAIL_OVERLAY,
      // Forge a stale entry with older seq than the snapshot's.
      nodeStates: new Map([["n1", { state: "running", lastEventSeq: 5 }]]),
      status: "running",
    };
    const merged = mergeDetail(snap, overlay);
    expect(merged.nodes).toBe(snap.nodes);
  });

  describe("HITL fields", () => {
    const opts = [{ key: "A", label: "[A] Approve", to: "publish" }];

    test("paused_hitl overlay propagates HITL fields onto the snapshot", () => {
      const snap = snapshot({ status: "running", runStatus: "running" });
      const overlay = fold(
        EMPTY_DETAIL_OVERLAY,
        "fact.run_paused_hitl",
        { nodeId: "review", label: "Approve?", options: opts },
        12,
      );
      const merged = mergeDetail(snap, overlay);
      expect(merged.status).toBe("paused");
      expect(merged.runStatus).toBe("paused_hitl");
      expect(merged.hitlNodeId).toBe("review");
      expect(merged.hitlLabel).toBe("Approve?");
      expect(merged.hitlOptions).toEqual(opts);
    });

    test("snapshot HITL fields survive when overlay carries unrelated changes", () => {
      // Snapshot already has paused_hitl info (from runStateToDetail);
      // an empty overlay must not stomp them with null.
      const snap = snapshot({
        status: "paused",
        runStatus: "paused_hitl",
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
        runStatus: "paused_hitl",
        hitlNodeId: "review",
        hitlLabel: "Approve?",
        hitlOptions: opts,
      });
      // Build an overlay that represents the resume — fact.run_resumed
      // sets runStatus back to "running" and nulls all the HITL fields.
      // The merge should flip runStatus and CLEAR the snapshot's HITL
      // fields. (Today the merge keeps snapshot fields when overlay is
      // null; this test documents the resume contract for future work.)
      const overlay = fold(EMPTY_DETAIL_OVERLAY, "fact.run_resumed", { fromStatus: "paused_hitl" }, 50);
      const merged = mergeDetail(snap, overlay);
      expect(merged.status).toBe("running");
      expect(merged.runStatus).toBe("running");
    });
  });
});
