// Smoke test for the web scaffold + router mount.
//
// Why no `screen` import:
//   `@testing-library/dom` initializes its global `screen` object at module
//   load, capturing `document.body` at that moment. Since we register the
//   DOM lazily (see `./setup.ts` for why), `screen` is guaranteed-broken
//   at load time. We sidestep this by using the `{ container }` returned
//   by `render()` and `within(container)` — both resolve at call time.
//
// Why every test injects a memory router:
//   The persistent layout (sidebar, badge, breadcrumb) lives *inside*
//   the route tree (`AppShell` is the layout route's element). Under
//   happy-dom, `BrowserRouter` resolves to the pathname `"blank"`,
//   which doesn't match any route; React Router then throws via its
//   default error boundary and the layout never mounts.
//
//   Memory routers with an explicit `/` initialEntry sidestep that.
//   Status itself flows through `HealthContext` (App provides), so
//   the badge re-renders on flips even with an injected router.

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
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
  return {
    baseUrl,
    health: overrides.health ?? (async () => ({ ok: true })),
    listPipelines: overrides.listPipelines ?? (async (): Promise<PipelineSummary[]> => []),
    listWorkflows: overrides.listWorkflows ?? (async () => []),
    getPipelineEvents: overrides.getPipelineEvents ?? (async () => ({ events: [], lastSeq: 0 })),
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
    getPipelineEventsUrl: eventsUrl,
    getPipelineSteps: async () => [],
    pipelineEventsUrl: overrides.pipelineEventsUrl ?? eventsUrl,
  };
}

function mountApp(client: ApiClient, path = "/") {
  const router = createMemoryRouter(createRoutes({ api: client }), { initialEntries: [path] });
  return render(<App apiClient={client} router={router} />);
}

describe("App", () => {
  useDom();

  afterEach(() => {
    cleanup();
  });

  it("renders the connected badge when /health returns ok", async () => {
    const client = stubClient();
    const { container } = mountApp(client);
    const q = within(container);

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
    const { container } = mountApp(client);
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
    const { container } = mountApp(client);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
    });
  });

  it("renders the pipelines list at the `/pipelines` route", async () => {
    // `/` is now the Home dashboard; the table-shaped list lives at
    // `/pipelines`. This test still exists to cover the App→router
    // wiring; the dedicated `Home.test.tsx` covers the new landing.
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
    const { container } = mountApp(client, "/pipelines");
    await waitFor(() => {
      expect(within(container).getByTestId("pipelines-table")).toBeTruthy();
    });
    // The row links at /pipelines/<runId> and renders the workflow badge.
    // (The list no longer shows the raw runId as cell text — see
    // `PipelinesList.test.tsx` for the full row-shape contract.)
    const link = container.querySelector('a[href="/pipelines/run-1"]');
    expect(link).toBeTruthy();
    // At least one row renders — any <tr> inside the table's <tbody>.
    const tbodyRows = container.querySelectorAll("[data-testid='pipelines-table'] tbody tr");
    expect(tbodyRows.length).toBe(1);
  });
});
