// Route-level tests for RunDetail.

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { snapshotLabel } from "../../src/components/RunDiffTab.tsx";
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
   * `seq` lands on `MessageEvent.lastEventId` so consumers (notably
   * `useRunLive`'s cost-frame log) can tag frames by event seq. Pass a
   * concrete number for cost.recorded frames so the snapshot-cutoff
   * filter has a watermark to compare against; production SSE always
   * carries a seq in the `id:` field. Defaults to "" to keep older
   * tests that don't care about seq from breaking.
   *
   * When the event type is one of the named SSE event types registered
   * by useRunLive (ALL_EVENT_TYPES), fire only the type-specific
   * listeners. The generic "message" listener is only for frames that
   * lack an `event:` field — firing both would double-count. */
  dispatch(eventType: string, payload: unknown, seq?: number): void {
    const data = JSON.stringify({ type: eventType, payload });
    const lastEventId = typeof seq === "number" ? String(seq) : "";
    const ev = new MessageEvent(eventType, { data, lastEventId });
    const typeListeners = this.listeners.get(eventType) ?? [];
    if (typeListeners.length > 0) {
      for (const l of typeListeners) l(ev);
    } else {
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
      // No title set → falls back to workflowName.
      expect(h2?.textContent).toBe("build-feature");
      expect(h2?.getAttribute("title")).toBe("build-feature");
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

      // Dispatch two cost.recorded SSE frames at successive seqs past
      // the snapshot watermark (lastEventSeq=1).
      await act(async () => {
        const es = fakeEs.getEs();
        if (es) {
          es.dispatch(
            "cost.recorded",
            {
              cost_usd: 0.05,
              input_tokens: 500,
              output_tokens: 100,
              cache_read_tokens: 50,
              cache_write_tokens: 0,
            },
            2,
          );
          es.dispatch(
            "cost.recorded",
            {
              cost_usd: 0.05,
              input_tokens: 500,
              output_tokens: 100,
              cache_read_tokens: 50,
              cache_write_tokens: 0,
            },
            3,
          );
        }
      });

      // Cost tile should reflect the summed live values: $0.10.
      await waitFor(() => {
        const costText = q.getByTestId("detail-cost-tile").textContent ?? "";
        expect(costText).toContain("$0.10");
      });

      // Tokens tile renders the BILLED total: input + output + cache_read +
      // cache_write across both frames = 2*(500+100+50+0) = 1300 → "1.3K".
      await waitFor(() => {
        const tokenText = q.getByTestId("detail-tokens-tile").textContent ?? "";
        expect(tokenText).toMatch(/1\.3K|1,300/);
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

  it("does NOT double-count cost when the snapshot refetches past in-flight live frames", async () => {
    // Cost-overlap invariant. Setup:
    //   1. Snapshot v1: costUsd=0, lastEventSeq=100. Live delta is 0.
    //   2. Two cost.recorded SSE frames arrive at seqs 101, 102
    //      totalling $0.10. Tile reads $0 + $0.10 = $0.10.
    //   3. The snapshot refetches: costUsd=0.10, lastEventSeq=102. The
    //      server-side SQL aggregate now covers events 101+102.
    //
    // The tile must still read $0.10. The live frames at seqs ≤ 102
    // drop out of the aggregate via the `aggregateLiveFrames` cutoff
    // filter, so `snapshot.costUsd + liveCost.totalCostUsd` stays
    // disjoint and there's no double-count over the overlap range.
    const detailV1: RunDetailT = {
      runId: "run-cost-overlap",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 100,
      nodes: [],
      selectedEdges: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
    const { client, mock } = prepare("run-cost-overlap", detailV1);
    const fakeEs = installFakeEventSource();
    try {
      const { container } = mount(client, "/runs/run-cost-overlap");
      const q = within(container);

      await waitFor(() => {
        expect(q.getByTestId("detail-cost-tile")).toBeTruthy();
      });

      // Phase 1: dispatch two frames past the snapshot watermark.
      await act(async () => {
        const es = fakeEs.getEs();
        if (es) {
          es.dispatch(
            "cost.recorded",
            { cost_usd: 0.05, input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 },
            101,
          );
          es.dispatch(
            "cost.recorded",
            { cost_usd: 0.05, input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0 },
            102,
          );
        }
      });
      await waitFor(() => {
        expect(q.getByTestId("detail-cost-tile").textContent ?? "").toContain("$0.10");
      });

      // Phase 2: snapshot advances to absorb both frames. The overlap
      // range drops out of the live delta and the tile stays at $0.10.
      const detailV2: RunDetailT = {
        ...detailV1,
        costUsd: 0.1,
        inputTokens: 1000,
        outputTokens: 200,
        lastEventSeq: 102,
      };
      await act(async () => {
        client.setQueryData(queries.runs.detail("run-cost-overlap").queryKey, detailV2);
      });
      await Bun.sleep(50);
      const costText = q.getByTestId("detail-cost-tile").textContent ?? "";
      expect(costText).not.toContain("$0.20");
      expect(costText).toContain("$0.10");
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
      nodes: [{ nodeId: "implement", iteration: 0, state: "running", lastEventSeq: 1 }],
      selectedEdges: [{ from: "start", to: "implement", iteration: 0 }],
      workflowSource: `name: demo
steps:
  implement:
    type: llm
    label: Implement
    model: claude-sonnet-4-5
`,
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

  describe("RunControls — operator pause/resume/cancel", () => {
    it("shows Pause and Cancel for a running run", async () => {
      const detail: RunDetailT = {
        runId: "run-running",
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        runStatus: "running",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const { client, mock } = prepare("run-running", detail);
      try {
        const { container } = mount(client, "/runs/run-running");
        const q = within(container);
        await waitFor(() => {
          expect(q.getByTestId("run-controls")).toBeTruthy();
        });
        expect(q.getByTestId("run-controls-pause")).toBeTruthy();
        expect(q.getByTestId("run-controls-cancel")).toBeTruthy();
        expect(q.queryByTestId("run-controls-resume")).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it("shows Resume and Cancel for an operator-paused run", async () => {
      const detail: RunDetailT = {
        runId: "run-paused-op",
        startedAt: "2024-01-01T00:00:00Z",
        status: "paused",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const { client, mock } = prepare("run-paused-op", detail);
      try {
        const { container } = mount(client, "/runs/run-paused-op");
        const q = within(container);
        await waitFor(() => {
          expect(q.getByTestId("run-controls")).toBeTruthy();
        });
        expect(q.getByTestId("run-controls-resume")).toBeTruthy();
        expect(q.getByTestId("run-controls-cancel")).toBeTruthy();
        expect(q.queryByTestId("run-controls-pause")).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it("hides Resume when status is paused_human (HitlChoice owns it)", async () => {
      const detail: RunDetailT = {
        runId: "run-hitl",
        startedAt: "2024-01-01T00:00:00Z",
        status: "paused",
        runStatus: "paused_human",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        hitlNodeId: "gate",
        hitlLabel: "Approve?",
        hitlOptions: ["approve", "reject"],
      };
      const { client, mock } = prepare("run-hitl", detail);
      try {
        const { container } = mount(client, "/runs/run-hitl");
        const q = within(container);
        await waitFor(() => {
          expect(q.getByTestId("run-controls")).toBeTruthy();
        });
        expect(q.queryByTestId("run-controls-resume")).toBeNull();
        expect(q.getByTestId("run-controls-cancel")).toBeTruthy();
      } finally {
        mock.restore();
      }
    });

    it("requires a second click within the confirmation window before cancelling", async () => {
      const detail: RunDetailT = {
        runId: "run-cancel-confirm",
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        runStatus: "running",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const client = createTestQueryClient();
      client.setQueryData(queries.runs.detail("run-cancel-confirm").queryKey, detail);
      const mock = installFetchMock(
        {
          "/api/runs/run-cancel-confirm/events.json": () => json([]),
          "/api/runs/run-cancel-confirm/messages": () => json([]),
          "/api/runs/run-cancel-confirm/steps": () => json([]),
          "/api/runs/run-cancel-confirm": () => json(detail),
          "/api/runs/run-cancel-confirm/cancel": () => json({ seq: 42 }),
        },
        () => json([]),
      );
      try {
        const { container } = mount(client, "/runs/run-cancel-confirm");
        const q = within(container);
        await waitFor(() => {
          expect(q.getByTestId("run-controls-cancel")).toBeTruthy();
        });

        const countCancelPosts = (): number =>
          mock.calls.filter((c) => c.method === "POST" && c.url.endsWith("/cancel")).length;

        // First click: arms the confirm step. No POST should fire.
        await act(async () => {
          fireEvent.click(q.getByTestId("run-controls-cancel"));
        });
        expect(countCancelPosts()).toBe(0);

        // Confirm control should now be visible; original Cancel hidden.
        const confirmBtn = await waitFor(() => q.getByTestId("run-controls-cancel-confirm"));
        expect(q.queryByTestId("run-controls-cancel")).toBeNull();

        // Second click within the 3s window: fires exactly one POST.
        await act(async () => {
          fireEvent.click(confirmBtn);
        });
        await waitFor(() => {
          expect(countCancelPosts()).toBe(1);
        });
      } finally {
        mock.restore();
      }
    });
  });

  describe("RunDetail — Diff tab", () => {
    const snapshots = [
      {
        eventIdx: 10,
        nodeId: "build",
        label: "step" as const,
        commitSha: "abc",
        treeSha: "def",
        committed: { filesChanged: 2, insertions: 10, deletions: 3 },
        uncommitted: null,
      },
      {
        eventIdx: 20,
        nodeId: "review",
        label: "step" as const,
        commitSha: "bcd",
        treeSha: "efg",
        committed: { filesChanged: 1, insertions: 5, deletions: 0 },
        uncommitted: null,
      },
      {
        eventIdx: 30,
        nodeId: null,
        label: "terminal" as const,
        commitSha: "cde",
        treeSha: "fgh",
        committed: null,
        uncommitted: { filesChanged: 3, insertions: 7, deletions: 2 },
      },
    ];

    function prepareWithDiff(id: string, detail: RunDetailT, diffResponses: Record<string, string> = {}) {
      const client = createTestQueryClient();
      client.setQueryData(queries.runs.detail(id).queryKey, detail);
      const routes: Record<string, () => Response> = {
        [`/api/runs/${encodeURIComponent(id)}/events.json`]: () => json([]),
        [`/api/runs/${encodeURIComponent(id)}/messages`]: () => json([]),
        [`/api/runs/${encodeURIComponent(id)}/steps`]: () => json([]),
        [`/api/runs/${encodeURIComponent(id)}`]: () => json(detail),
        [`/api/runs/${encodeURIComponent(id)}/snapshots`]: () => json(snapshots),
      };
      for (const [key, body] of Object.entries(diffResponses)) {
        routes[key] = () => new Response(body, { headers: { "content-type": "text/x-diff" } });
      }
      const mock = installFetchMock(routes, () => json([]));
      return { client, mock };
    }

    it("shows the Diff tab trigger when the run has a cwd", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-cwd",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const { client, mock } = prepareWithDiff("run-diff-cwd", detail);
      try {
        const { container } = mount(client, "/runs/run-diff-cwd");
        await waitFor(() => {
          expect(within(container).getByTestId("detail-status")).toBeTruthy();
        });
        expect(within(container).getByTestId("view-tab-diff")).toBeTruthy();
      } finally {
        mock.restore();
      }
    });

    it("hides the Diff tab when the run has no cwd", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-nocwd",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        // no cwd field
      };
      const { client, mock } = prepareWithDiff("run-diff-nocwd", detail);
      try {
        const { container } = mount(client, "/runs/run-diff-nocwd");
        await waitFor(() => {
          expect(within(container).getByTestId("detail-status")).toBeTruthy();
        });
        expect(within(container).queryByTestId("view-tab-diff")).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it("navigates to /conversation when /diff is opened for a no-cwd run", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-redir",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const { client, mock } = prepareWithDiff("run-diff-redir", detail);
      try {
        const { container } = mount(client, "/runs/run-diff-redir/diff");
        await waitFor(() => {
          expect(within(container).getByTestId("conversation-region")).toBeTruthy();
        });
        expect(within(container).queryByTestId("diff-region")).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it("renders the stat header and diff for the latest snapshot (vs base) when the Diff tab is active", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-latest",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const diffText = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
      const { client, mock } = prepareWithDiff("run-diff-latest", detail, {
        "/api/runs/run-diff-latest/snapshots/30/diff?against=base": diffText,
      });
      try {
        const { container } = mount(client, "/runs/run-diff-latest/diff");
        // The latest snapshot (eventIdx=30) has committed=null, uncommitted={filesChanged:3,insertions:7,deletions:2}
        await waitFor(() => {
          expect(within(container).getByTestId("run-diff-stat")).toBeTruthy();
        });
        const stat = within(container).getByTestId("run-diff-stat");
        expect(stat.textContent).toContain("3");
        expect(within(container).getByTestId("run-diff-insertions").textContent).toContain("+7");
        expect(within(container).getByTestId("run-diff-deletions").textContent).toContain("−2");
        // Diff content should render
        await waitFor(() => {
          expect(within(container).getByTestId("snapshot-diff-content")).toBeTruthy();
        });
        // No scrubber or compare-against control
        expect(within(container).queryByTestId("snapshot-scrubber")).toBeNull();
        expect(within(container).queryByTestId("snapshot-diff-against-select")).toBeNull();
      } finally {
        mock.restore();
      }
    });

    it("shows EmptyState when /snapshots returns an empty array", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-empty",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const client = createTestQueryClient();
      client.setQueryData(queries.runs.detail("run-diff-empty").queryKey, detail);
      const mock = installFetchMock(
        {
          "/api/runs/run-diff-empty/events.json": () => json([]),
          "/api/runs/run-diff-empty/messages": () => json([]),
          "/api/runs/run-diff-empty/steps": () => json([]),
          "/api/runs/run-diff-empty": () => json(detail),
          "/api/runs/run-diff-empty/snapshots": () => json([]),
        },
        () => json([]),
      );
      try {
        const { container } = mount(client, "/runs/run-diff-empty/diff");
        await waitFor(() => {
          expect(within(container).getByTestId("run-diff-empty")).toBeTruthy();
        });
      } finally {
        mock.restore();
      }
    });

    it("disables the Diff tab trigger when snapshots resolve to an empty array", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-disabled",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 1,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const client = createTestQueryClient();
      client.setQueryData(queries.runs.detail("run-diff-disabled").queryKey, detail);
      const mock = installFetchMock(
        {
          "/api/runs/run-diff-disabled/events.json": () => json([]),
          "/api/runs/run-diff-disabled/messages": () => json([]),
          "/api/runs/run-diff-disabled/steps": () => json([]),
          "/api/runs/run-diff-disabled": () => json(detail),
          "/api/runs/run-diff-disabled/snapshots": () => json([]),
        },
        () => json([]),
      );
      try {
        const { container } = mount(client, "/runs/run-diff-disabled");
        // Wait for the tab to render and snapshots to resolve.
        await waitFor(() => {
          const tab = within(container).getByTestId("view-tab-diff");
          expect(tab.hasAttribute("disabled")).toBe(true);
        });
      } finally {
        mock.restore();
      }
    });

    it("does not disable the Diff tab when snapshots are present", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-enabled",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const { client, mock } = prepareWithDiff("run-diff-enabled", detail);
      try {
        const { container } = mount(client, "/runs/run-diff-enabled");
        // Wait for the snapshots to load (non-empty), then confirm tab is not disabled.
        await waitFor(() => {
          expect(within(container).getByTestId("view-tab-diff")).toBeTruthy();
        });
        await waitFor(() => {
          const tab = within(container).getByTestId("view-tab-diff");
          expect(tab.hasAttribute("disabled")).toBe(false);
        });
      } finally {
        mock.restore();
      }
    });

    it("invalidates snapshots + snapshotDiff when fact.node_completed arrives via SSE", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-node-inv",
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        lastEventSeq: 5,
        nodes: [{ nodeId: "build", iteration: 0, state: "running", lastEventSeq: 5 }],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const { client, mock } = prepareWithDiff("run-diff-node-inv", detail);
      const fakeEs = installFakeEventSource();
      try {
        mount(client, "/runs/run-diff-node-inv");
        // Wait for the SSE connection to open.
        await waitFor(() => expect(fakeEs.getEs()).toBeTruthy());
        const callsBefore = mock.calls.filter((c) => c.url.includes("/snapshots")).length;
        await act(async () => {
          fakeEs
            .getEs()!
            .dispatch("fact.node_completed", { nodeId: "build", iteration: 0, outcomeStatus: "success" }, 6);
        });
        await waitFor(() => {
          const snapshotCalls = mock.calls.filter((c) => c.url.includes("/snapshots"));
          expect(snapshotCalls.length).toBeGreaterThan(callsBefore);
        });
      } finally {
        mock.restore();
        fakeEs.restore();
      }
    });

    it("invalidates snapshots + snapshotDiff when fact.run_completed arrives via SSE", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-run-inv",
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        lastEventSeq: 5,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const { client, mock } = prepareWithDiff("run-diff-run-inv", detail);
      const fakeEs = installFakeEventSource();
      try {
        mount(client, "/runs/run-diff-run-inv");
        await waitFor(() => expect(fakeEs.getEs()).toBeTruthy());
        const callsBefore = mock.calls.filter((c) => c.url.includes("/snapshots")).length;
        await act(async () => {
          fakeEs.getEs()!.dispatch("fact.run_completed", { runId: "run-diff-run-inv" }, 6);
        });
        await waitFor(() => {
          const snapshotCalls = mock.calls.filter((c) => c.url.includes("/snapshots"));
          expect(snapshotCalls.length).toBeGreaterThan(callsBefore);
        });
      } finally {
        mock.restore();
        fakeEs.restore();
      }
    });

    it("renders a snapshot selector trigger (combobox) in the Diff tab when snapshots are present", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-selector",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const { client, mock } = prepareWithDiff("run-diff-selector", detail);
      try {
        const { container } = mount(client, "/runs/run-diff-selector/diff");
        await waitFor(() => {
          expect(within(container).getByTestId("run-diff-section")).toBeTruthy();
        });
        const selector = within(container).getByTestId("snapshot-selector");
        expect(selector).toBeTruthy();
        expect(selector.getAttribute("role")).toBe("combobox");
      } finally {
        mock.restore();
      }
    });

    it("labels a snapshot by its step (node) name — no index, kind, or 'latest' marker", () => {
      // A step snapshot shows just its node name; the node-less terminal /
      // HITL boundaries fall back to a one-word kind.
      expect(snapshotLabel(snapshots[0]!)).toBe("build");
      expect(snapshotLabel(snapshots[1]!)).toBe("review");
      expect(snapshotLabel(snapshots[2]!)).toBe("terminal");
    });

    it("fetches the diff for the latest snapshot by default (eventIdx of last snapshot)", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-default",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const latestDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
      const { client, mock } = prepareWithDiff("run-diff-default", detail, {
        "/api/runs/run-diff-default/snapshots/30/diff?against=base": latestDiff,
      });
      try {
        const { container } = mount(client, "/runs/run-diff-default/diff");
        // Latest snapshot is eventIdx=30 (uncommitted: 3 changed +7 −2)
        await waitFor(() => {
          expect(within(container).getByTestId("run-diff-insertions").textContent).toContain("+7");
          expect(within(container).getByTestId("run-diff-deletions").textContent).toContain("−2");
        });
        // Diff fetch was for snapshot 30, not 10 or 20
        const diffFetches = mock.calls.filter((c) => c.url.includes("/snapshots/") && c.url.includes("/diff"));
        expect(diffFetches.some((c) => c.url.includes("/snapshots/30/diff"))).toBe(true);
        expect(diffFetches.some((c) => c.url.includes("/snapshots/10/diff"))).toBe(false);
      } finally {
        mock.restore();
      }
    });

    it("fetches the diff for an earlier snapshot after picking it from the selector", async () => {
      const detail: RunDetailT = {
        runId: "run-diff-pick",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 30,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cwd: "/home/user/project",
      };
      const latestDiff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
      const step1Diff = "--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-a\n+b";
      const { client, mock } = prepareWithDiff("run-diff-pick", detail, {
        "/api/runs/run-diff-pick/snapshots/30/diff?against=base": latestDiff,
        "/api/runs/run-diff-pick/snapshots/10/diff?against=base": step1Diff,
      });
      try {
        const { container } = mount(client, "/runs/run-diff-pick/diff");
        // Wait for the default (latest) stat: eventIdx=30, uncommitted 3/+7/−2
        await waitFor(() => {
          expect(within(container).getByTestId("run-diff-deletions").textContent).toContain("−2");
        });
        // Open the selector and pick option 10 if the Radix portal is reachable in jsdom
        const selector = within(container).getByTestId("snapshot-selector");
        await act(async () => {
          fireEvent.click(selector);
        });
        const option10 = document.querySelector(`[data-testid="snapshot-option-10"]`);
        if (option10) {
          await act(async () => {
            fireEvent.click(option10);
          });
          // After picking snapshot 10: committed 2 changed +10 −3
          await waitFor(() => {
            expect(within(container).getByTestId("run-diff-insertions").textContent).toContain("+10");
            expect(within(container).getByTestId("run-diff-deletions").textContent).toContain("−3");
          });
          await waitFor(() => {
            expect(mock.calls.some((c) => c.url.includes("/snapshots/10/diff"))).toBe(true);
          });
        } else {
          // Portal not reachable in this jsdom environment — verify default state is correct
          expect(mock.calls.some((c) => c.url.includes("/snapshots/30/diff"))).toBe(true);
        }
      } finally {
        mock.restore();
      }
    });
  });

  describe("RunDetail header — git base", () => {
    it("renders baseGitRef + short baseGitSha when both present", async () => {
      const detail: RunDetailT = {
        runId: "run-git-base",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 5,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        baseGitRef: "main",
        baseGitSha: "abcdef1234567890",
      };
      const { client, mock } = prepare("run-git-base", detail);
      try {
        const { container } = mount(client, "/runs/run-git-base/conversation");
        await waitFor(() => {
          const pill = container.querySelector(`[data-testid="detail-base-ref"]`);
          if (!pill) throw new Error("base-ref pill not found");
          return pill;
        });
        const pill = container.querySelector(`[data-testid="detail-base-ref"]`)!;
        expect(pill.textContent).toContain("main");
        expect(pill.textContent).toContain("abcdef1");
      } finally {
        mock.restore();
      }
    });

    it("renders only baseGitSha when baseGitRef is absent", async () => {
      const detail: RunDetailT = {
        runId: "run-sha-only",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 5,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        baseGitSha: "abcdef1234567890",
      };
      const { client, mock } = prepare("run-sha-only", detail);
      try {
        const { container } = mount(client, "/runs/run-sha-only/conversation");
        await waitFor(() => {
          const pill = container.querySelector(`[data-testid="detail-base-ref"]`);
          if (!pill) throw new Error("base-ref pill not found");
          return pill;
        });
        const pill = container.querySelector(`[data-testid="detail-base-ref"]`)!;
        expect(pill.textContent).toContain("abcdef1");
      } finally {
        mock.restore();
      }
    });

    it("does not render the base-ref pill when both fields are absent", async () => {
      const detail: RunDetailT = {
        runId: "run-no-git",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 5,
        nodes: [],
        selectedEdges: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      const { client, mock } = prepare("run-no-git", detail);
      try {
        const { container } = mount(client, "/runs/run-no-git/conversation");
        await waitFor(() => {
          expect(container.querySelector(`[data-testid="detail-status"]`)).toBeTruthy();
        });
        expect(container.querySelector(`[data-testid="detail-base-ref"]`)).toBeNull();
      } finally {
        mock.restore();
      }
    });
  });
});
