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
});
