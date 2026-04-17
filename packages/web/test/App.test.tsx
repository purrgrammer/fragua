// Smoke test for the web scaffold + router mount.
//
// Why no `screen` import:
//   `@testing-library/dom` initializes its global `screen` object at module
//   load, capturing `document.body` at that moment. Since we register the
//   DOM lazily (see `./setup.ts` for why), `screen` is guaranteed-broken
//   at load time. We sidestep this by using the `{ container }` returned
//   by `render()` and `within(container)` — both resolve at call time.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { App } from "../src/App.tsx";
import type { ApiClient, PipelineDetail, PipelineSummary } from "../src/lib/api.ts";
import { createRoutes } from "../src/lib/router.tsx";
import { useDom } from "./setup.ts";

type Overrides = Partial<ApiClient>;

function stubClient(overrides: Overrides = {}): ApiClient {
  const baseUrl = overrides.baseUrl ?? "/api";
  const graphUrl = overrides.getPipelineGraphUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/graph.svg`);
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
  return {
    baseUrl,
    health: overrides.health ?? (async () => ({ ok: true })),
    listPipelines: overrides.listPipelines ?? (async (): Promise<PipelineSummary[]> => []),
    getPipeline:
      overrides.getPipeline ??
      (async (id: string): Promise<PipelineDetail> => ({
        runId: id,
        startedAt: "2024-01-01T00:00:00Z",
        status: "unknown",
        lastEventSeq: 0,
        nodes: [],
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      })),
    getPipelineGraph: overrides.getPipelineGraph ?? (async () => "<svg></svg>"),
    getPipelineGraphUrl: graphUrl,
    getPipelineEventsUrl: eventsUrl,
    pipelineEventsUrl: overrides.pipelineEventsUrl ?? eventsUrl,
  };
}

describe("App", () => {
  useDom();

  afterEach(() => {
    cleanup();
  });

  it("renders the connected badge when /health returns ok", async () => {
    const client = stubClient();
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("loading");

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("connected");
    });
    expect(q.getByTestId("health-badge").textContent).toContain("connected");
  });

  it("renders the error badge when /health rejects", async () => {
    const client = stubClient({
      health: async () => {
        throw new Error("boom");
      },
    });
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
    });
    const badge = q.getByTestId("health-badge");
    expect(badge.textContent).toContain("error");
    expect(badge.getAttribute("title")).toBe("boom");
  });

  it("renders the error badge when /health reports ok:false", async () => {
    const client = stubClient({ health: async () => ({ ok: false }) });
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
    });
  });

  it("renders the pipelines list at the default `/` route", async () => {
    const client = stubClient({
      listPipelines: async () => [
        {
          runId: "run-1",
          workflow: "wf",
          startedAt: "2024-01-01T00:00:00Z",
          status: "success",
          eventCount: 10,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });
    // Use an injected MemoryRouter to avoid depending on happy-dom's
    // default URL ("about:blank") — BrowserRouter resolves to "/blank"
    // under happy-dom, which doesn't match any of our routes.
    const router = createMemoryRouter(createRoutes({ api: client }), { initialEntries: ["/"] });
    const { container } = render(<App apiClient={client} router={router} />);
    await waitFor(() => {
      expect(within(container).getByTestId("pipelines-table")).toBeTruthy();
    });
    expect(within(container).getByText("run-1")).toBeTruthy();
  });
});
