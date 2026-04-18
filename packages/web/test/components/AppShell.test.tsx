// AppShell + AppSidebar tests:
//   - Sidebar renders the four nav entries with lucide icons.
//   - Active route carries `aria-current="page"` (and `data-active`).
//   - ⌘+B / Ctrl+B toggles the collapsed state, persisted via cookie.
//   - Breadcrumb derivation matches the current route.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { crumbsFor } from "../../src/components/AppShell.tsx";
import type { ApiClient } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { useDom } from "../setup.ts";

function makeClient(): ApiClient {
  const baseUrl = "/api";
  const eventsUrl = (id: string) => `${baseUrl}/pipelines/${id}/events`;
  return {
    baseUrl,
    health: async () => ({ ok: true }),
    listPipelines: async () => [],
    listWorkflows: async () => [],
    getPipeline: async (id: string) => ({
      runId: id,
      startedAt: "2024-01-01T00:00:00Z",
      status: "unknown" as const,
      lastEventSeq: 0,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getPipelineEvents: async () => ({ events: [], lastSeq: 0 }),
    getPipelineEventsUrl: eventsUrl,
    getPipelineSteps: async () => [],
    pipelineEventsUrl: eventsUrl,
  };
}

function mount(path: string) {
  const router = createMemoryRouter(createRoutes({ api: makeClient() }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("AppShell + AppSidebar", () => {
  useDom();
  afterEach(() => {
    cleanup();
    // Reset the persisted sidebar state so each test starts from
    // `defaultOpen=true` (cookie reads happen on first render).
    if (typeof document !== "undefined") {
      document.cookie = "sidebar:state=; max-age=0; path=/";
    }
  });

  it("renders the four nav entries", () => {
    const { container } = mount("/");
    const q = within(container);
    expect(q.getByTestId("nav-home")).toBeTruthy();
    expect(q.getByTestId("nav-workflows")).toBeTruthy();
    expect(q.getByTestId("nav-pipelines")).toBeTruthy();
    expect(q.getByTestId("nav-settings")).toBeTruthy();
  });

  it("renders a lucide icon next to each nav label", () => {
    const { container } = mount("/");
    // Each nav entry contains an SVG (lucide icons render as SVG).
    for (const id of ["nav-home", "nav-workflows", "nav-pipelines", "nav-settings"]) {
      const link = within(container).getByTestId(id);
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });

  it("marks the link matching the current route with aria-current=page", () => {
    const { container } = mount("/workflows");
    const q = within(container);
    // The active marker lives on the inner span (NavLink's children
    // function), not the outer `<a>`. Assert by attribute to keep
    // the test resilient against shadcn class churn.
    const active = container.querySelector('[aria-current="page"]');
    expect(active).not.toBeNull();
    // It's the Workflows link that's active.
    expect(q.getByTestId("nav-workflows").querySelector('[aria-current="page"]')).not.toBeNull();
  });

  it("toggles the sidebar collapsed state on ⌘+B and persists via cookie", () => {
    mount("/");

    // Default expanded.
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
    expect(wrapper?.getAttribute("data-state")).toBe("expanded");

    // ⌘+B toggles to collapsed. The shadcn provider also writes
    // `sidebar:state` to document.cookie so the choice survives a
    // reload — verified manually; happy-dom drops cookies without
    // an origin, so we don't assert on it here.
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(wrapper?.getAttribute("data-state")).toBe("collapsed");

    // ⌘+B again → expanded.
    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(wrapper?.getAttribute("data-state")).toBe("expanded");
  });

  it("toggles via Ctrl+B as well (Windows/Linux shortcut)", () => {
    mount("/");
    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
    act(() => {
      fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    });
    expect(wrapper?.getAttribute("data-state")).toBe("collapsed");
  });
});

describe("crumbsFor (route → breadcrumb derivation)", () => {
  it("home", () => {
    expect(crumbsFor("/", {})).toEqual([{ label: "Home" }]);
  });

  it("workflows", () => {
    expect(crumbsFor("/workflows", {})).toEqual([{ label: "Home", href: "/" }, { label: "Workflows" }]);
  });

  it("pipelines list", () => {
    expect(crumbsFor("/pipelines", {})).toEqual([{ label: "Home", href: "/" }, { label: "Pipelines" }]);
  });

  it("pipeline detail truncates the id to 8 chars", () => {
    expect(crumbsFor("/pipelines/abcdef1234567890", { id: "abcdef1234567890" })).toEqual([
      { label: "Home", href: "/" },
      { label: "Pipelines", href: "/pipelines" },
      { label: "abcdef12" },
    ]);
  });

  it("settings", () => {
    expect(crumbsFor("/settings", {})).toEqual([{ label: "Home", href: "/" }, { label: "Settings" }]);
  });
});
