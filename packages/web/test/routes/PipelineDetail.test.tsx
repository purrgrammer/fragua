// Route-level tests for PipelineDetail.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { PipelineDetail as PipelineDetailT } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function mount(client: ReturnType<typeof createTestQueryClient>, path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

/**
 * Seed the detail query for a given runId, and install a fake fetch that
 * satisfies the SSE-bootstrap endpoint (`/pipelines/:id/events.json`)
 * with an empty payload so `useRunConversation` settles into a clean
 * state without real network.
 */
function prepare(id: string, detail: PipelineDetailT) {
  const client = createTestQueryClient();
  client.setQueryData(queries.pipelines.detail(id).queryKey, detail);
  const mock = installFetchMock(
    {
      [`/api/pipelines/${encodeURIComponent(id)}/events.json`]: () => json({ events: [], lastSeq: 0 }),
      [`/api/pipelines/${encodeURIComponent(id)}/steps`]: () => json([]),
      [`/api/pipelines/${encodeURIComponent(id)}`]: () => json(detail),
    },
    () => json([]),
  );
  return { client, mock };
}

describe("PipelineDetail", () => {
  useDom();
  afterEach(() => cleanup());

  it("fetches the pipeline for the :id from the URL and renders the conversation region", async () => {
    const detail: PipelineDetailT = {
      runId: "abc12345xyz",
      workflowName: "build-feature",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 3,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("abc12345xyz", detail);
    try {
      const { container } = mount(client, "/runs/abc12345xyz");
      await waitFor(() => {
        expect(within(container).getByTestId("detail-status").textContent).toBe("running");
      });
      const h2 = container.querySelector("h2");
      expect(h2?.textContent).toBe("abc12345");
      expect(h2?.getAttribute("title")).toBe("abc12345xyz");
      expect(within(container).getByTestId("detail-event-count").textContent).toBe("3");
      expect(within(container).getByTestId("conversation-region")).toBeTruthy();
      expect(within(container).queryByTestId("graph-panel")).toBeNull();
      expect(within(container).queryByTestId("timeline-placeholder")).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("renders cost + tokens + duration in the header when metrics are present", async () => {
    const detail: PipelineDetailT = {
      runId: "run-metrics",
      workflowName: "w",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 4,
      nodes: [],
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
        expect(q.getByTestId("detail-cost")).toBeTruthy();
      });

      expect(q.getByTestId("detail-cost").textContent).toBe("$0.420");
      expect(q.getByTestId("detail-tokens").textContent).toMatch(/3K/);
      expect(q.getByTestId("detail-duration").textContent).toBe("1m 15s");
      const usage = q.getByTestId("detail-usage");
      const title = usage.getAttribute("title") ?? "";
      expect(title).toContain("input 2,500");
      expect(title).toContain("output 500");
    } finally {
      mock.restore();
    }
  });

  it("renders '—' for missing metrics without leaking raw values", async () => {
    const detail: PipelineDetailT = {
      runId: "run-empty",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 1,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-empty", detail);
    try {
      const { container } = mount(client, "/runs/run-empty");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-duration")).toBeTruthy();
      });
      expect(q.getByTestId("detail-duration").textContent).toBe("—");
      const usage = q.getByTestId("detail-usage");
      expect((usage.textContent ?? "").replace(/\s+/g, " ")).toContain("cost: — · tokens: —");
    } finally {
      mock.restore();
    }
  });

  it("never renders the raw ISO startedAt string to the user", async () => {
    const detail: PipelineDetailT = {
      runId: "run-dates",
      startedAt: "2024-06-01T12:34:56Z",
      status: "success",
      lastEventSeq: 2,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { client, mock } = prepare("run-dates", detail);
    try {
      const { container } = mount(client, "/runs/run-dates");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-started")).toBeTruthy();
      });
      const started = q.getByTestId("detail-started");
      expect(started.textContent ?? "").not.toContain("2024-06-01T12:34:56Z");
      expect(started.textContent ?? "").not.toContain("T12:34");
    } finally {
      mock.restore();
    }
  });

  it("on detail fetch failure shows EmptyState and does not leak the error", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock(
      {
        "/api/pipelines/run-999": () =>
          new Response("secret-detail-error", { status: 500, statusText: "Internal Server Error" }),
        "/api/pipelines/run-999/events.json": () => json({ events: [], lastSeq: 0 }),
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
  it("exposes a Graph tab that renders the live graph + inspector when the tab is active", async () => {
    const detail: PipelineDetailT = {
      runId: "run-graph",
      workflowName: "demo",
      startedAt: "2024-01-01T00:00:00Z",
      status: "running",
      lastEventSeq: 1,
      nodes: [{ nodeId: "implement", state: "running", lastEventSeq: 1 }],
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
      const { container } = mount(client, "/runs/run-graph");
      const q = within(container);
      // Tab button present + starts on conversation.
      await waitFor(() => {
        expect(q.getByTestId("view-tab-graph")).toBeTruthy();
      });
      expect(q.queryByTestId("graph-region")).toBeNull();

      // Switch to the graph tab.
      const tab = q.getByTestId("view-tab-graph") as HTMLButtonElement;
      tab.click();
      await waitFor(() => {
        expect(q.getByTestId("graph-region")).toBeTruthy();
      });
      // Orientation is top-to-bottom for the pipeline graph tab.
      const canvas = q.getByTestId("graphview");
      expect(canvas.getAttribute("data-orientation")).toBe("TB");
      // Inspector empty until a node is clicked.
      expect(q.getByTestId("node-inspector-empty")).toBeTruthy();
    } finally {
      mock.restore();
    }
  });
});
