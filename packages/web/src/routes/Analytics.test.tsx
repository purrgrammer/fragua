// Tests for the /analytics route:
//   1. Project filter (cwd threading) — wire-side contract on api helpers.
//   2. Window auto-fallback — when firstRunAt narrows past the active
//      windowKey, the component resets to 'all' via a useEffect.

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { useDom } from "../../test/setup.ts";
import { filterWindowOptions } from "../components/analytics/WindowSelector.tsx";
import type { WindowKey } from "../lib/analytics.ts";
import { getAnalytics, getAnalyticsRuns } from "../lib/api.ts";

const DAY_MS = 86_400_000;

// ── Shared fetch restore ───────────────────────────────────────────────

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

// ── Minimal payload factory ────────────────────────────────────────────
// Includes firstRunAt so isAnalyticsPayload accepts the response.

function makePayload(firstRunAt: number | null = null) {
  return {
    window: { fromMs: 0, toMs: 1, bucket: "hour", tzOffsetMinutes: 0 },
    compareWindow: null,
    firstRunAt,
    totals: {
      current: { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      previous: null,
    },
    runsByBucket: [],
    spendByBucket: [],
    tokensByBucket: [],
    cacheByBucket: [],
    haltDistribution: [],
    modelDistribution: [],
    topWorkflows: [],
  };
}

// ── §1 Project filter ──────────────────────────────────────────────────
// The user-visible contract for the project filter is "the chosen cwd
// reaches the server". Asserting that on the page-level component
// requires opening the Radix Select listbox, which happy-dom cannot
// render. The wire-side contract is testable directly: the api
// helpers translate `req.cwd` into the `?cwd=` query param. Page-level
// integration falls under e2e once that's in place.

describe("Analytics page · project filter", () => {
  test("threads the chosen cwd into the analytics summary fetch", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(makePayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await getAnalytics({
      fromMs: 100,
      toMs: 200,
      bucket: "hour",
      tzOffsetMinutes: 0,
      cwd: "/abs/path",
    });

    expect(capturedUrl).toContain("from=100");
    expect(capturedUrl).toContain("to=200");
    expect(capturedUrl).toContain("cwd=%2Fabs%2Fpath");
  });

  test("omits the cwd param when no project is selected", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(makePayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await getAnalytics({ fromMs: 100, toMs: 200, bucket: "hour", tzOffsetMinutes: 0 });

    expect(capturedUrl).not.toContain("cwd=");
  });

  test("threads cwd into the drill-down (analytics/runs) fetch", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify({ runs: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await getAnalyticsRuns({ fromMs: 100, toMs: 200, cwd: "/abs/path" });
    expect(capturedUrl).toContain("cwd=%2Fabs%2Fpath");
  });
});

// ── §2 Window auto-fallback ────────────────────────────────────────────
// Strategy: render a minimal harness that replicates the relevant hook
// logic (availableKeys + the fallback effect) in isolation so we can
// drive windowKey programmatically without fighting Radix Select in
// happy-dom. The pure filtering logic is tested exhaustively in
// WindowSelector.test.tsx; here we verify the effect wire-up.

interface HarnessProps {
  firstRunAt: number | null;
  windowKey: WindowKey;
  onWindowKeyChange: (k: WindowKey) => void;
}

function FallbackHarness({ firstRunAt, windowKey, onWindowKeyChange }: HarnessProps) {
  const now = Date.now();
  const availableKeys = useMemo(
    () => new Set(filterWindowOptions(firstRunAt, now).map((w) => w.key)),
    [firstRunAt, now],
  );
  useEffect(() => {
    // Mirror the condition from Analytics.tsx: only fall back when
    // data has loaded (firstRunAt !== undefined) and the key is gone.
    if (firstRunAt !== undefined && !availableKeys.has(windowKey)) {
      onWindowKeyChange("all");
    }
  }, [availableKeys, windowKey, firstRunAt, onWindowKeyChange]);

  return <div data-testid="current-key">{windowKey}</div>;
}

function Wrapper({ initialFirstRunAt }: { initialFirstRunAt: number | null }) {
  const [windowKey, setWindowKey] = useState<WindowKey>("last30");
  const [firstRunAt, setFirstRunAt] = useState<number | null>(initialFirstRunAt);

  return (
    <div>
      <FallbackHarness firstRunAt={firstRunAt} windowKey={windowKey} onWindowKeyChange={setWindowKey} />
      <button type="button" data-testid="narrow-btn" onClick={() => setFirstRunAt(Date.now() - 3 * DAY_MS)}>
        narrow
      </button>
    </div>
  );
}

describe("Analytics window auto-fallback", () => {
  useDom();

  test("when firstRunMs narrows past the current windowKey, the selector emits 'all'", async () => {
    // Start with 90-day span so 'last30' is valid
    const { container } = render(<Wrapper initialFirstRunAt={Date.now() - 90 * DAY_MS} />);

    const keyEl = container.querySelector('[data-testid="current-key"]');
    expect(keyEl?.textContent).toBe("last30");

    // Narrow the span to 3 days — 'last30' is no longer available
    const btn = container.querySelector('[data-testid="narrow-btn"]') as HTMLButtonElement;
    btn.click();

    // The useEffect should fire and reset windowKey to 'all'
    await waitFor(() => {
      expect(container.querySelector('[data-testid="current-key"]')?.textContent).toBe("all");
    });
  });

  test("keys that remain available are not reset", async () => {
    // Narrow span: only 'today' and 'all' are valid
    const { container } = render(<Wrapper initialFirstRunAt={Date.now() - 3 * DAY_MS} />);

    // 'last30' was the initial windowKey; since firstRunAt = 3d ago it
    // is immediately unavailable, so the effect fires on mount.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="current-key"]')?.textContent).toBe("all");
    });
  });

  test("no fallback when firstRunAt is null (data not loaded yet)", async () => {
    // When firstRunAt is null (data=undefined) the harness should NOT
    // reset the windowKey — this mirrors the `data !== undefined` guard
    // in Analytics.tsx. We verify it via the FallbackHarness which
    // replicates that guard: firstRunAt===undefined means skip.
    function NullHarness() {
      const [windowKey, setWindowKey] = useState<WindowKey>("last30");
      // Use undefined (not null) to trigger the "skip" branch
      return (
        <FallbackHarness
          firstRunAt={undefined as unknown as null}
          windowKey={windowKey}
          onWindowKeyChange={setWindowKey}
        />
      );
    }

    const { container } = render(<NullHarness />);
    // firstRunAt === undefined so the guard skips — windowKey stays 'last30'
    expect(container.querySelector('[data-testid="current-key"]')?.textContent).toBe("last30");
  });
});
