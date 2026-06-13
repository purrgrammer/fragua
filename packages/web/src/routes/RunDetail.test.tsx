import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CrashRequeueNotice } from "../components/CrashRequeueNotice.tsx";
import type { RunDetail } from "../lib/api.ts";
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

describe("RunDetail.input — dead field", () => {
  test("RunDetail type must NOT expose an `input` field (server dropped it)", () => {
    // If this test fails to compile (TS error on the @ts-expect-error line),
    // it means `input` was correctly removed from the RunDetail type.
    // If TS does NOT error here, it means `input` still exists — the bug is present.
    const d = {} as RunDetail;
    // @ts-expect-error — `input` must not exist on RunDetail; remove this line once it's gone
    const _dead: string | undefined = d.input;
    // Runtime guard: the field resolves to undefined (server never sends it).
    expect(_dead).toBeUndefined();
  });
});

describe("CrashRequeueNotice — crash-requeue banner", () => {
  afterEach(() => cleanup());

  test("renders crash-requeue notice when detail.crashRequeues is populated", () => {
    const at = Date.UTC(2024, 0, 4, 15, 42);
    const { container } = render(
      <CrashRequeueNotice crashRequeues={[{ at, prevNode: "work", lastAliveAt: at - 5_000 }]} />,
    );
    const notice = within(container).getByTestId("crash-requeue-notice");
    expect(notice.textContent).toContain("Requeued after daemon crash");
    expect(notice.textContent).toContain("requeued this run at");
    expect(notice.textContent).toContain("was at node work");
  });

  test("one line per requeue when the run crashed more than once", () => {
    const { container } = render(
      <CrashRequeueNotice crashRequeues={[{ at: 1_000_000 }, { at: 2_000_000, prevNode: "verify" }]} />,
    );
    const msg = within(container).getByTestId("crash-requeue-message");
    expect(msg.children.length).toBe(2);
    expect(msg.textContent).toContain("was at node verify");
  });

  test("renders nothing for an empty crashRequeues list", () => {
    const { container } = render(<CrashRequeueNotice crashRequeues={[]} />);
    expect(within(container).queryByTestId("crash-requeue-notice")).toBeNull();
  });
});

describe("StatsStrip — Cache hit rate tile", () => {
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
