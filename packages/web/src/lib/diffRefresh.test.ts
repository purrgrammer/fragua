import { describe, expect, test } from "vitest";
import { diffNeedsRefetch } from "./diffRefresh.ts";
import type { DetailOverlay } from "./useDetailOverlay.ts";

type NodeEntry = DetailOverlay["nodeStates"] extends Map<string, infer V> ? V : never;

function node(nodeId: string, state: NodeEntry["state"], seq = 1): NodeEntry {
  return { nodeId, iteration: 0, pass: 0, state, lastEventSeq: seq };
}

function slice(entries: Array<[string, NodeEntry]>, status: DetailOverlay["status"] = null) {
  return { nodeStates: new Map(entries), status };
}

describe("diffNeedsRefetch", () => {
  test("no change → no refetch", () => {
    const prev = slice([["work#0.0", node("work", "running")]]);
    const next = slice([["work#0.0", node("work", "running")]]);
    expect(diffNeedsRefetch(prev, next)).toBe(false);
  });

  test("a step transitioning to completed → refetch", () => {
    const prev = slice([["work#0.0", node("work", "running")]]);
    const next = slice([["work#0.0", node("work", "completed")]]);
    expect(diffNeedsRefetch(prev, next)).toBe(true);
  });

  test("a step transitioning to failed → refetch", () => {
    const prev = slice([["work#0.0", node("work", "running")]]);
    const next = slice([["work#0.0", node("work", "failed")]]);
    expect(diffNeedsRefetch(prev, next)).toBe(true);
  });

  test("a newly-seen already-finished step → refetch", () => {
    const prev = slice([]);
    const next = slice([["work#0.0", node("work", "completed")]]);
    expect(diffNeedsRefetch(prev, next)).toBe(true);
  });

  test("a step already finished in the prev overlay → no refetch", () => {
    const prev = slice([["work#0.0", node("work", "completed")]]);
    const next = slice([["work#0.0", node("work", "completed")]]);
    expect(diffNeedsRefetch(prev, next)).toBe(false);
  });

  test("run terminating to success → refetch even with no node change", () => {
    const prev = slice([["work#0.0", node("work", "running")]], "running");
    const next = slice([["work#0.0", node("work", "running")]], "success");
    expect(diffNeedsRefetch(prev, next)).toBe(true);
  });

  test("run pausing (non-terminal status change) → no refetch", () => {
    const prev = slice([["work#0.0", node("work", "running")]], "running");
    const next = slice([["work#0.0", node("work", "running")]], "paused");
    expect(diffNeedsRefetch(prev, next)).toBe(false);
  });

  test("a second step finishing after the first → refetch", () => {
    const prev = slice([
      ["a#0.0", node("a", "completed")],
      ["b#0.0", node("b", "running")],
    ]);
    const next = slice([
      ["a#0.0", node("a", "completed")],
      ["b#0.0", node("b", "completed")],
    ]);
    expect(diffNeedsRefetch(prev, next)).toBe(true);
  });
});
