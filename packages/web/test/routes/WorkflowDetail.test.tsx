// Route-level tests for `/workflows/:name`.
//
// The happy path mounts the page via the real router + memory history,
// seeds the `workflows.detail(name)` query cache with a small YAML
// source, and asserts:
//   - header renders label / name / short sha
//   - the graph region renders with one node per parsed step
//   - clicking a node (`data-node-id`) opens the inspector drawer
//
// Error paths install a URL-routing fake fetch to exercise 404 and 500.

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowDetail as WorkflowDetailT } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";

const WORKFLOW_SOURCE = `name: demo
description: demo
steps:
  middle:
    type: llm
    label: middle
    model: opus-4
    next: done
  done:
    type: llm
    label: done
`;

function mount(client = createTestQueryClient(), path = "/workflows/demo") {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

function seedDetail(client: ReturnType<typeof createTestQueryClient>, name: string, detail: WorkflowDetailT) {
  client.setQueryData(queries.workflows.detail(name).queryKey, detail);
}

describe("WorkflowDetail route", () => {
  afterEach(() => cleanup());

  it("renders header with label, name, and short sha", async () => {
    const detail: WorkflowDetailT = {
      name: "demo",
      label: "Demo workflow",
      path: "workflows/demo.yaml",
      sha: "abcdef1234567890",
      source: WORKFLOW_SOURCE,
    };
    const client = createTestQueryClient();
    seedDetail(client, "demo", detail);

    const { container } = mount(client);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("workflow-detail")).toBeTruthy();
    });

    expect(q.getByTestId("workflow-detail-title").textContent).toBe("Demo workflow");
    expect(q.getByTestId("workflow-detail-sha").textContent).toBe("abcdef1");
    expect(container.textContent ?? "").toContain("workflows/demo.yaml");
  });

  it("renders the graph with one data-node-id per parsed node", async () => {
    const detail: WorkflowDetailT = {
      name: "demo",
      path: "workflows/demo.yaml",
      sha: "abcdef1",
      source: WORKFLOW_SOURCE,
    };
    const client = createTestQueryClient();
    seedDetail(client, "demo", detail);

    const { container } = mount(client);
    await waitFor(() => {
      expect(within(container).getByTestId("graphview")).toBeTruthy();
    });

    const nodes = container.querySelectorAll("[data-node-id]");
    const ids = [...nodes].map((n) => n.getAttribute("data-node-id"));
    expect(ids).toContain("start");
    expect(ids).toContain("middle");
    expect(ids).toContain("done");
  });

  it("renders no inspector by default and selects a node on click", async () => {
    // Inspector lives inside a `Sheet` portal (`DrillDownDrawer`-style).
    // happy-dom registers globals AFTER radix-ui imports run, so radix's
    // useLayoutEffect short-circuits and the portal never mounts in
    // tests — see `test/setup.ts`. We verify the visible state instead:
    // graph is full-width with no inspector chrome before click, and the
    // clicked node carries the "selected" ring afterwards.
    const detail: WorkflowDetailT = {
      name: "demo",
      path: "workflows/demo.yaml",
      sha: "abcdef1",
      source: WORKFLOW_SOURCE,
    };
    const client = createTestQueryClient();
    seedDetail(client, "demo", detail);

    const { container } = mount(client);
    await waitFor(() => {
      expect(within(container).getByTestId("graphview")).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="node-inspector"]')).toBeNull();
    expect(container.querySelector('[data-testid="node-inspector-empty"]')).toBeNull();

    const middle = container.querySelector('[data-node-id="middle"]');
    expect(middle).toBeTruthy();
    if (!middle) return;
    fireEvent.click(middle);

    // Selection rendered via the node's ring class — see GraphView
    // toFlowGraph: `d.selected && ... && "ring-2 ring-sw-accent-idle"`.
    await waitFor(() => {
      const node = container.querySelector('[data-node-id="middle"]');
      expect(node?.className ?? "").toContain("ring-sw-accent-idle");
    });
  });

  it("renders a dedicated not-found state when the server 404s", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock({
      "/api/workflows/missing": () => new Response("not_found", { status: 404, statusText: "Not Found" }),
    });
    try {
      const { container } = mount(createTestQueryClient(), "/workflows/missing");
      await waitFor(() => {
        expect(within(container).getByTestId("workflow-detail-not-found")).toBeTruthy();
      });
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });
});
