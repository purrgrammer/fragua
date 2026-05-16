import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { useDom } from "../../test/setup.ts";
import { StatsStrip } from "./RunDetail.tsx";

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
