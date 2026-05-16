import { afterEach, describe, expect, test } from "bun:test";
import type { FeedEvent } from "@swarm/types";
import { cleanup, render, within } from "@testing-library/react";
import { useDom } from "../../test/setup.ts";
import { computeDescendantRefreshToken, StatsStrip } from "./RunDetail.tsx";

// Minimal RunDetail payload — only the fields StatsStrip reads.
const baseDetail = {
  runId: "run-abc123",
  status: "success" as const,
  startedAt: new Date().toISOString(),
  lastEventSeq: 0,
  nodes: [],
  selectedEdges: [],
  costUsd: 0.05,
  inputTokens: 600,
  outputTokens: 200,
  cacheReadTokens: 400,
  cacheWriteTokens: 0,
  durationMs: 1234,
};

describe("StatsStrip — Cache hit rate tile", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders detail-cache-tile with correct percentage (400/1000 = 40%)", () => {
    const { container } = render(<StatsStrip detail={baseDetail} />);
    const tile = within(container).getByTestId("detail-cache-tile");
    expect(tile).toBeTruthy();
    // tile textContent contains the label + value; check the value portion.
    // Whole percentages render without a trailing `.0` (40%, not 40.0%) so
    // the tile reads cleanly when the rate happens to land on a round value.
    expect(tile.textContent).toContain("40%");
  });

  test("renders — when input + cacheRead is zero", () => {
    const { container } = render(<StatsStrip detail={{ ...baseDetail, inputTokens: 0, cacheReadTokens: 0 }} />);
    const tile = within(container).getByTestId("detail-cache-tile");
    expect(tile.textContent).toContain("—");
  });

  test("renders — when cacheReadTokens is undefined (missing from payload)", () => {
    const { cacheReadTokens: _omitted, ...detailWithoutCache } = baseDetail;
    const { container } = render(<StatsStrip detail={detailWithoutCache} />);
    const tile = within(container).getByTestId("detail-cache-tile");
    expect(tile.textContent).toContain("—");
  });

  test("renders loading skeleton (no crash) when detail is null", () => {
    const { container } = render(<StatsStrip detail={null} />);
    // Tile still renders with the skeleton placeholder — no value text, but testId present
    const tile = within(container).getByTestId("detail-cache-tile");
    expect(tile).toBeTruthy();
  });
});

function feedEvt(type: string, runId: string, seq: number): FeedEvent {
  return { type, runId, seq, ts: 0, writer: "daemon", payload: {} } as unknown as FeedEvent;
}

describe("computeDescendantRefreshToken", () => {
  test("ignores fact.message_appended from a child run", () => {
    const childRunIds = new Set(["child-1"]);
    const feedEvents = [feedEvt("fact.message_appended", "child-1", 7)];
    expect(computeDescendantRefreshToken(feedEvents, childRunIds)).toBe("");
  });

  test("bumps for fact.run_completed from a child run", () => {
    const childRunIds = new Set(["child-1"]);
    const feedEvents = [feedEvt("fact.run_completed", "child-1", 9)];
    expect(computeDescendantRefreshToken(feedEvents, childRunIds)).toBe("child-1:9");
  });

  test("ignores events from runs outside childRunIds", () => {
    const childRunIds = new Set(["child-1"]);
    const feedEvents = [feedEvt("fact.run_completed", "unrelated", 5)];
    expect(computeDescendantRefreshToken(feedEvents, childRunIds)).toBe("");
  });

  test("returns empty string when childRunIds is empty", () => {
    const feedEvents = [feedEvt("fact.run_completed", "child-1", 3)];
    expect(computeDescendantRefreshToken(feedEvents, new Set())).toBe("");
  });
});
