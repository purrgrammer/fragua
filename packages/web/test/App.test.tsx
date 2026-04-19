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

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { App } from "../src/App.tsx";
import { createRoutes } from "../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json } from "./helpers/with-query-client.tsx";
import { useDom } from "./setup.ts";

function mountApp(mocks: Record<string, () => Response | Promise<Response>>, path = "/") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  const fetchMock = installFetchMock(mocks, () => new Response("not found", { status: 404 }));
  const queryClient = createTestQueryClient();
  const result = render(<App router={router} queryClient={queryClient} />);
  return { ...result, fetchMock };
}

describe("App", () => {
  useDom();

  afterEach(() => {
    cleanup();
  });

  it("renders the connected badge when /health returns ok", async () => {
    const { container, fetchMock } = mountApp({
      "/api/health": () => json({ ok: true }),
      "/api/pipelines": () => json([]),
    });
    const q = within(container);
    try {
      await waitFor(() => {
        expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("connected");
      });
      expect(q.getByTestId("health-badge").textContent).toContain("connected");
    } finally {
      fetchMock.restore();
    }
  });

  it("renders the error badge when /health rejects", async () => {
    const { container, fetchMock } = mountApp({
      "/api/health": () => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
      "/api/pipelines": () => json([]),
    });
    const q = within(container);
    try {
      await waitFor(() => {
        expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
      });
      const badge = q.getByTestId("health-badge");
      expect(badge.textContent).toContain("error");
      expect(badge.getAttribute("title") ?? "").toMatch(/500|Internal Server Error/);
    } finally {
      fetchMock.restore();
    }
  });

  it("renders the error badge when /health reports ok:false", async () => {
    const { container, fetchMock } = mountApp({
      "/api/health": () => json({ ok: false }),
      "/api/pipelines": () => json([]),
    });
    const q = within(container);
    try {
      await waitFor(() => {
        expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
      });
    } finally {
      fetchMock.restore();
    }
  });

  it("renders the pipelines list at the `/pipelines` route", async () => {
    // `/` is the Home dashboard; the table-shaped list lives at `/pipelines`.
    const { container, fetchMock } = mountApp(
      {
        "/api/health": () => json({ ok: true }),
        "/api/pipelines": () =>
          json([
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
          ]),
      },
      "/runs",
    );
    try {
      await waitFor(() => {
        expect(within(container).getByTestId("pipelines-table")).toBeTruthy();
      });
      const link = container.querySelector('a[href="/runs/run-1"]');
      expect(link).toBeTruthy();
      const tbodyRows = container.querySelectorAll("[data-testid='pipelines-table'] tbody tr");
      expect(tbodyRows.length).toBe(1);
    } finally {
      fetchMock.restore();
    }
  });
});
