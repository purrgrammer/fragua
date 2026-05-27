// Route-level tests for `/workflows`. Mount inside a memory router,
// seed the react-query cache via `setQueryData` for happy-path renders,
// and install a URL-routing fake `fetch` for error paths.

import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function mount(client = createTestQueryClient(), path = "/workflows") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

describe("Workflows route", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one row per workflow with name / path / short sha", async () => {
    const rows: WorkflowSummary[] = [
      { name: "alpha", path: "workflows/alpha.yaml", sha: "abcdef1234567890", label: "Alpha" },
      { name: "beta", path: "workflows/beta.yaml", sha: "fedcba0987654321" },
    ];
    const client = createTestQueryClient();
    client.setQueryData(queries.workflows.list().queryKey, rows);

    const { container } = mount(client);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("workflows-table")).toBeTruthy();
    });

    expect(q.getByTestId("workflow-row-alpha")).toBeTruthy();
    expect(q.getByTestId("workflow-row-beta")).toBeTruthy();
    expect(q.getByText("Alpha")).toBeTruthy();
    expect(q.getByText("abcdef1")).toBeTruthy();
    expect(q.queryByText("abcdef1234567890")).toBeNull();
  });

  it("renders the empty state when no workflows exist", async () => {
    const client = createTestQueryClient();
    client.setQueryData(queries.workflows.list().queryKey, [] as WorkflowSummary[]);

    const { container } = mount(client);
    await waitFor(() => {
      expect(within(container).getByTestId("workflows-empty")).toBeTruthy();
    });
    expect(within(container).queryByTestId("workflows-table")).toBeNull();
  });

  it("renders the error state when the fetch rejects", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock({
      "/api/workflows": () => new Response("nope", { status: 500, statusText: "Internal Server Error" }),
    });
    try {
      const { container } = mount();
      await waitFor(() => {
        expect(within(container).getByTestId("workflows-error")).toBeTruthy();
      });
      expect(container.textContent ?? "").not.toContain("nope");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });
  it("links each row's name to /workflows/:name", async () => {
    const rows: WorkflowSummary[] = [
      { name: "alpha", path: "workflows/alpha.yaml", sha: "abcdef1234567890", label: "Alpha" },
    ];
    const client = createTestQueryClient();
    client.setQueryData(queries.workflows.list().queryKey, rows);

    const { container } = mount(client);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("workflow-link-alpha")).toBeTruthy();
    });
    const link = q.getByTestId("workflow-link-alpha") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/workflows/alpha");
    expect(link.textContent).toBe("Alpha");
  });
});
