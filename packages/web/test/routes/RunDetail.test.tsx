// Route-level tests for RunDetail.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { RunDetail as RunDetailT } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

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
      expect(h2?.textContent).toBe("abc12345");
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
    const detail: RunDetailT = {
      runId: "run-empty",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
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
