// Route-level tests for PipelineDetail.
//
// Coverage:
//   - The id in the URL is threaded through to api.getPipeline.
//   - When the detail fetch succeeds, the header renders the status +
//     event count + locale-aware date + cost / tokens / duration, and the
//     graph fetch is kicked off to the correct relative URL.
//   - When the detail fetch fails, we render the EmptyState rather than
//     a raw error banner (and nothing leaks the underlying message).

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { ApiClient, PipelineDetail as PipelineDetailT } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { useDom } from "../setup.ts";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const baseUrl = overrides.baseUrl ?? "/api";
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
  return {
    baseUrl,
    health: async () => ({ ok: true }),
    listPipelines: async () => [],
    listWorkflows: overrides.listWorkflows ?? (async () => []),
    getPipeline: async (id: string): Promise<PipelineDetailT> => ({
      runId: id,
      workflow: "build-feature.dot",
      workflowName: "build-feature",
      startedAt: "2024-01-01T00:00:00Z",
      status: "success",
      lastEventSeq: 7,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getPipelineEventsUrl: eventsUrl,
    getPipelineSteps: async () => [],
    steerRun: async () => ({ id: "stub" }),
    pauseRun: async () => ({ id: "stub" }),
    resumeRun: async () => ({ id: "stub" }),
    cancelRun: async () => ({ id: "stub" }),
    listSkills: async () => [],
    getSkill: async () => {
      throw new Error("getSkill not stubbed");
    },
    pipelineEventsUrl: eventsUrl,
    getPipelineEvents: overrides.getPipelineEvents ?? (async () => ({ events: [], lastSeq: 0 })),
    ...overrides,
  };
}

function mount(api: ApiClient, path: string) {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("PipelineDetail", () => {
  useDom();
  afterEach(() => cleanup());

  it("fetches the pipeline for the :id from the URL and renders the conversation region", async () => {
    let fetchedId: string | undefined;
    const api = makeClient({
      getPipeline: async (id) => {
        fetchedId = id;
        return {
          runId: id,
          workflowName: "build-feature",
          startedAt: "2024-01-01T00:00:00Z",
          status: "running",
          lastEventSeq: 3,
          nodes: [],
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        };
      },
    });
    const { container } = mount(api, "/pipelines/abc12345xyz");

    await waitFor(() => {
      expect(within(container).getByTestId("detail-status").textContent).toBe("running");
    });
    expect(fetchedId).toBe("abc12345xyz");
    // Short id shown in the header; full id in title.
    const h2 = container.querySelector("h2");
    expect(h2?.textContent).toBe("abc12345");
    expect(h2?.getAttribute("title")).toBe("abc12345xyz");
    // Event count reflects lastEventSeq.
    expect(within(container).getByTestId("detail-event-count").textContent).toBe("3");
    // Conversation is the primary surface; the graph + timeline are gone.
    expect(within(container).getByTestId("conversation-region")).toBeTruthy();
    expect(within(container).queryByTestId("graph-panel")).toBeNull();
    expect(within(container).queryByTestId("timeline-placeholder")).toBeNull();
  });

  it("renders cost + tokens + duration in the header when metrics are present", async () => {
    const api = makeClient({
      getPipeline: async (id) => ({
        runId: id,
        workflowName: "w",
        startedAt: "2024-01-01T00:00:00Z",
        status: "success",
        lastEventSeq: 4,
        nodes: [],
        costUsd: 0.42,
        inputTokens: 2500,
        outputTokens: 500,
        durationMs: 75_000,
      }),
    });
    const { container } = mount(api, "/pipelines/run-metrics");
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("detail-cost")).toBeTruthy();
    });

    // Cost rendered via formatUsd (3 fraction digits for sub-$1).
    expect(q.getByTestId("detail-cost").textContent).toBe("$0.420");
    // Tokens rendered compact (2500+500 = 3000 → "3K" in en-US).
    expect(q.getByTestId("detail-tokens").textContent).toMatch(/3K/);
    // Duration rendered via formatDuration ("1m 15s").
    expect(q.getByTestId("detail-duration").textContent).toBe("1m 15s");
    // Long-form precise breakdown available via the tooltip.
    const usage = q.getByTestId("detail-usage");
    const title = usage.getAttribute("title") ?? "";
    expect(title).toContain("input 2,500");
    expect(title).toContain("output 500");
  });

  it("renders '—' for missing metrics without leaking raw values", async () => {
    const api = makeClient({
      getPipeline: async (id) => ({
        runId: id,
        startedAt: "2024-01-01T00:00:00Z",
        status: "running",
        lastEventSeq: 1,
        nodes: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        // durationMs omitted → helper falls back to "—".
      }),
    });
    const { container } = mount(api, "/pipelines/run-empty");
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("detail-duration")).toBeTruthy();
    });
    expect(q.getByTestId("detail-duration").textContent).toBe("—");
    // The usage line collapses to a clean "— · —" in the absence of any LLM calls.
    const usage = q.getByTestId("detail-usage");
    expect((usage.textContent ?? "").replace(/\s+/g, " ")).toContain("cost: — · tokens: —");
  });

  it("never renders the raw ISO startedAt string to the user", async () => {
    const api = makeClient({
      getPipeline: async (id) => ({
        runId: id,
        startedAt: "2024-06-01T12:34:56Z",
        status: "success",
        lastEventSeq: 2,
        nodes: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    });
    const { container } = mount(api, "/pipelines/run-dates");
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("detail-started")).toBeTruthy();
    });
    const started = q.getByTestId("detail-started");
    expect(started.textContent ?? "").not.toContain("2024-06-01T12:34:56Z");
    expect(started.textContent ?? "").not.toContain("T12:34");
  });

  it("on detail fetch failure shows EmptyState and does not leak the error", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const api = makeClient({
        getPipeline: async () => {
          throw new Error("secret-detail-error");
        },
      });
      const { container } = mount(api, "/pipelines/run-999");
      await waitFor(() => {
        expect(within(container).getByTestId("detail-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("secret-detail-error");
    } finally {
      console.warn = origWarn;
    }
  });
});
