// Route-level tests for RunDetail.

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { act, cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { RunDetail as RunDetailT } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

// ─── FakeEventSource ─────────────────────────────────────────────
// Minimal EventSource stand-in for injecting SSE frames into useRunLive.
// Overrides globalThis.EventSource so RunDetail picks it up without prop changes.

let _currentFakeEs: FakeEventSource | null = null;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 1; // OPEN
  private listeners: Map<string, Array<(ev: MessageEvent) => void>> = new Map();

  constructor(public readonly url: string) {
    _currentFakeEs = this;
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  close(): void {
    this.readyState = 2;
    _currentFakeEs = null;
  }

  /** Dispatch a JSON-serialised frame.
   * When the event type is one of the named SSE event types registered
   * by useRunLive (ALL_EVENT_TYPES), fire only the type-specific
   * listeners. The generic "message" listener is only for frames that
   * lack an `event:` field — firing both would double-count. */
  dispatch(eventType: string, payload: unknown): void {
    const data = JSON.stringify({ type: eventType, payload });
    const ev = new MessageEvent(eventType, { data, lastEventId: "" });
    // If there are type-specific listeners registered (useRunLive does
    // this for all ALL_EVENT_TYPES), prefer those only.
    const typeListeners = this.listeners.get(eventType) ?? [];
    if (typeListeners.length > 0) {
      for (const l of typeListeners) l(ev);
    } else {
      // Fall back to generic "message" listeners for un-typed frames.
      for (const l of this.listeners.get("message") ?? []) l(ev);
    }
  }
}

/** Install FakeEventSource as globalThis.EventSource for the duration of the test. */
function installFakeEventSource(): { restore: () => void; getEs: () => FakeEventSource | null } {
  const g = globalThis as { [key: string]: unknown };
  const original = g["EventSource"];
  g["EventSource"] = FakeEventSource;
  return {
    restore() {
      g["EventSource"] = original;
      _currentFakeEs = null;
    },
    getEs() {
      return _currentFakeEs;
    },
  };
}

function mount(client: ReturnType<typeof createTestQueryClient>, path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

/** Seed the detail query for a runId + satisfy the endpoints useRunLive
 * hits (messages + events) with empty payloads so the hook settles
 * without real network. */
function prepare(id: string, detail: RunDetailT) {
  const client = createTestQueryClient();
  client.setQueryData(queries.runs.detail(id).queryKey, detail);
  const mock = installFetchMock(
    {
      [`/api/runs/${encodeURIComponent(id)}/events.json`]: () => json([]),
      [`/api/runs/${encodeURIComponent(id)}/messages`]: () => json([]),
      [`/api/runs/${encodeURIComponent(id)}/steps`]: () => json([]),
      [`/api/runs/${encodeURIComponent(id)}`]: () => json(detail),
    },
    () => json([]),
  );
  return { client, mock };
}

describe("RunDetail", () => {
  useDom();
  afterEach(() => cleanup());

  it("fetches the run for the :id from the URL and renders the conversation region", async () => {
    const detail: RunDetailT = {
      runId: "abc12345xyz",
      workflowName: "build-feature",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 3,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("abc12345xyz", detail);
    try {
      const { container } = mount(client, "/runs/abc12345xyz");
      await waitFor(() => {
        expect(within(container).getByTestId("detail-status")).toBeTruthy();
      });
      const h2 = container.querySelector("h2");
      // shortRunId formats as `prefix…suffix` so runs queued in the
      // same second remain distinguishable.
      expect(h2?.textContent).toBe("abc1…5xyz");
      expect(h2?.getAttribute("title")).toBe("abc12345xyz");
      expect(within(container).getByTestId("conversation-region")).toBeTruthy();
      expect(within(container).queryByTestId("graph-region")).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("renders cost + tokens + duration stat tiles when metrics are present", async () => {
    const detail: RunDetailT = {
      runId: "run-metrics",
      workflowName: "w",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 4,
      nodes: [],
      selectedEdges: [],
      costUsd: 0.42,
      inputTokens: 2500,
      outputTokens: 500,
      durationMs: 75_000,
    };
    const { client, mock } = prepare("run-metrics", detail);
    try {
      const { container } = mount(client, "/runs/run-metrics");
      const q = within(container);

      await waitFor(() => {
        expect(q.getByTestId("detail-cost-tile")).toBeTruthy();
      });

      expect(q.getByTestId("detail-cost-tile").textContent).toContain("$0.420");
      expect(q.getByTestId("detail-tokens-tile").textContent).toMatch(/3K/);
      expect(q.getByTestId("detail-duration-tile").textContent).toContain("1m 15s");
      const tokensTile = q.getByTestId("detail-tokens-tile");
      const hint = tokensTile.getAttribute("title") ?? "";
      expect(hint).toContain("input 2,500");
      expect(hint).toContain("output 500");
    } finally {
      mock.restore();
    }
  });

  it("renders '—' for missing metrics without leaking raw values", async () => {
    // For a terminal run without durationMs the server value is authoritative
    // (undefined → formatDuration → "—"). The cost tile also shows "—" since
    // costUsd is 0 and there are no tokens.
    const detail: RunDetailT = {
      runId: "run-empty",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 1,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-empty", detail);
    try {
      const { container } = mount(client, "/runs/run-empty");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-duration-tile")).toBeTruthy();
      });
      // Terminal run with no durationMs → formatDuration(undefined) → "—".
      expect(q.getByTestId("detail-duration-tile").textContent).toContain("—");
    } finally {
      mock.restore();
    }
  });

  it("never renders the raw ISO startedAt string to the user", async () => {
    const detail: RunDetailT = {
      runId: "run-dates",
      startedAt: "2024-06-01T12:34:56Z",
      status: "success",
      lastEventSeq: 2,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-dates", detail);
    try {
      const { container } = mount(client, "/runs/run-dates");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-duration-tile")).toBeTruthy();
      });
      const body = container.textContent ?? "";
      // Visible body should not contain the ISO string. The started-at hint
      // lives on the duration tile as a `title` attribute; inspect that
      // separately to confirm it's hover-only.
      expect(body).not.toContain("2024-06-01T12:34:56Z");
      expect(body).not.toContain("T12:34");
    } finally {
      mock.restore();
    }
  });

  it("on detail fetch failure shows EmptyState and does not leak the error", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock(
      {
        "/api/runs/run-999": () =>
          new Response("secret-detail-error", { status: 500, statusText: "Internal Server Error" }),
        "/api/runs/run-999/events.json": () => json([]),
        "/api/runs/run-999/messages": () => json([]),
      },
      () => json([]),
    );
    try {
      const { container } = mount(createTestQueryClient(), "/runs/run-999");
      await waitFor(() => {
        expect(within(container).getByTestId("detail-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("secret-detail-error");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });

  it("duration tile ticks every second while run is live (running)", async () => {
    // Fix the system clock to a known point.
    const base = new Date("2024-06-01T12:00:00.000Z");
    setSystemTime(base);

    // startedAt is 5 seconds before the frozen clock.
    const startedAt = new Date(base.getTime() - 5_000).toISOString();
    const detail: RunDetailT = {
      runId: "run-ticking",
      startedAt,
      status: "running",
      lastEventSeq: 1,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-ticking", detail);
    try {
      const { container } = mount(client, "/runs/run-ticking");
      const q = within(container);

      // Initially Duration should read 5s.
      await waitFor(() => {
        expect(q.getByTestId("detail-duration-tile").textContent).toContain("5s");
      });

      // Advance fake clock by 2 seconds — the next setInterval tick will
      // read Date.now() = base + 2000, giving base+2000 - (base-5000) = 7000ms.
      setSystemTime(new Date(base.getTime() + 2_000));

      // Wait for the 1-second interval to fire and re-render.
      await waitFor(
        () => {
          expect(q.getByTestId("detail-duration-tile").textContent).toContain("7s");
        },
        { timeout: 3_000 },
      );
    } finally {
      mock.restore();
      // Reset system time so other tests are unaffected.
      setSystemTime(new Date());
    }
  });

  it("duration tile is frozen at server durationMs for terminal (success) runs", async () => {
    // Fix the system clock to a known point.
    const base = new Date("2024-06-01T12:00:00.000Z");
    setSystemTime(base);

    const startedAt = new Date(base.getTime() - 5_000).toISOString();
    const detail: RunDetailT = {
      runId: "run-terminal",
      startedAt,
      status: "success",
      lastEventSeq: 5,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      // Server durationMs is authoritative for terminal runs.
      durationMs: 3_000,
    };
    const { client, mock } = prepare("run-terminal", detail);
    try {
      const { container } = mount(client, "/runs/run-terminal");
      const q = within(container);

      // Duration should read the server's 3s, not the 5s wall-clock delta.
      await waitFor(() => {
        expect(q.getByTestId("detail-duration-tile").textContent).toContain("3s");
      });

      // Advance fake clock by 10 seconds — terminal runs must NOT drift.
      setSystemTime(new Date(base.getTime() + 10_000));

      // Give the component time to potentially (incorrectly) re-render.
      await Bun.sleep(1_200);

      // Value must still be the server-supplied 3s.
      expect(q.getByTestId("detail-duration-tile").textContent).toContain("3s");
    } finally {
      mock.restore();
      setSystemTime(new Date());
    }
  });

  it("stats strip live-updates cost and tokens from SSE cost.recorded events", async () => {
    const detail: RunDetailT = {
      runId: "run-live-cost",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 1,
      nodes: [],
      selectedEdges: [],
      // snapshot starts at zero — live events should update the tiles
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    const { client, mock } = prepare("run-live-cost", detail);
    const fakeEs = installFakeEventSource();
    try {
      const { container } = mount(client, "/runs/run-live-cost");
      const q = within(container);

      // Wait for the stats strip to render with initial snapshot values.
      await waitFor(() => {
        expect(q.getByTestId("detail-cost-tile")).toBeTruthy();
      });

      // Dispatch two cost.recorded SSE frames.
      await act(async () => {
        const es = fakeEs.getEs();
        if (es) {
          es.dispatch("cost.recorded", {
            cost_usd: 0.05,
            input_tokens: 500,
            output_tokens: 100,
            cache_read_tokens: 50,
            cache_write_tokens: 0,
          });
          es.dispatch("cost.recorded", {
            cost_usd: 0.05,
            input_tokens: 500,
            output_tokens: 100,
            cache_read_tokens: 50,
            cache_write_tokens: 0,
          });
        }
      });

      // Cost tile should reflect the summed live values: $0.10.
      await waitFor(() => {
        const costText = q.getByTestId("detail-cost-tile").textContent ?? "";
        expect(costText).toContain("$0.10");
      });

      // Tokens tile should reflect 1200 total (1000 input + 200 output).
      await waitFor(() => {
        const tokenText = q.getByTestId("detail-tokens-tile").textContent ?? "";
        // 1200 renders as "1.2K" in compact format
        expect(tokenText).toMatch(/1\.2K|1,200/);
      });

      // Cache tile should show a non-dash percentage (50+50=100 cache read,
      // 500+500=1000 input → 100/(1000+100) ≈ 9.1%).
      await waitFor(() => {
        const cacheText = q.getByTestId("detail-cache-tile").textContent ?? "";
        expect(cacheText).not.toBe("—");
        expect(cacheText).toContain("%");
      });
    } finally {
      mock.restore();
      fakeEs.restore();
    }
  });

  it("exposes a Graph tab that renders the live graph when the tab is active", async () => {
    const detail: RunDetailT = {
      runId: "run-graph",
      workflowName: "demo",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 1,
      nodes: [{ nodeId: "implement", state: "running", lastEventSeq: 1 }],
      selectedEdges: [{ from: "start", to: "implement" }],
      workflowSource: `digraph demo {
        start [shape=Mdiamond]
        implement [shape=box, label="Implement", model="claude-sonnet-4-5"]
        done [shape=Msquare]
        start -> implement -> done
      }`,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-graph", detail);
    try {
      const { container } = mount(client, "/runs/run-graph/graph");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("graph-region")).toBeTruthy();
      });
      const canvas = q.getByTestId("graphview");
      expect(canvas.getAttribute("data-orientation")).toBe("TB");
    } finally {
      mock.restore();
    }
  });
});
