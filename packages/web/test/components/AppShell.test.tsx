// AppShell + AppSidebar tests:
//   - Sidebar renders the Operate / Build groups (seven nav entries) with lucide icons.
//   - Active route carries `aria-current="page"` (and `data-active`).
//   - ⌘+B / Ctrl+B toggles the collapsed state, persisted via cookie.
//   - Breadcrumb derivation matches the current route.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { crumbsFor } from "../../src/components/AppShell.tsx";
import { createRoutes } from "../../src/lib/router.tsx";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function mount(path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />);
}

describe("AppShell + AppSidebar", () => {
  useDom();
  afterEach(() => {
    cleanup();
    // Reset the persisted sidebar state so each test starts from
    // `defaultOpen=true` (cookie reads happen on first render).
    if (typeof document !== "undefined") {
      // biome-ignore lint/suspicious/noDocumentCookie: test resets sidebar persistence cookie
      document.cookie = "sidebar:state=; max-age=0; path=/";
    }
  });

  it("renders the nav entries", () => {
    const { container } = mount("/");
    const q = within(container);
    expect(q.getByTestId("nav-watchtower")).toBeTruthy();
    expect(q.getByTestId("nav-inbox")).toBeTruthy();
    expect(q.getByTestId("nav-runs")).toBeTruthy();
    expect(q.getByTestId("nav-analytics")).toBeTruthy();
    expect(q.getByTestId("nav-projects")).toBeTruthy();
    expect(q.getByTestId("nav-workflows")).toBeTruthy();
    expect(q.getByTestId("nav-providers")).toBeTruthy();
  });

  it("renders a lucide icon next to each nav label", () => {
    const { container } = mount("/");
    for (const id of [
      "nav-watchtower",
      "nav-inbox",
      "nav-runs",
      "nav-analytics",
      "nav-projects",
      "nav-workflows",
      "nav-providers",
    ]) {
      const link = within(container).getByTestId(id);
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders Operate and Build group labels in order", () => {
    const { container } = mount("/");
    const labels = Array.from(container.querySelectorAll('[data-slot="sidebar-group-label"]')).map(
      (el) => el.textContent?.trim() ?? "",
    );
    expect(labels).toEqual(["Operate", "Build"]);
  });

  it("groups Operate items: Watchtower, Inbox, Runs, Schedules, Analytics in order", () => {
    const { container } = mount("/");
    const groups = Array.from(container.querySelectorAll('[data-slot="sidebar-group"]'));
    const operate = groups.find(
      (g) => g.querySelector('[data-slot="sidebar-group-label"]')?.textContent?.trim() === "Operate",
    );
    expect(operate).toBeTruthy();
    const ids = Array.from(operate!.querySelectorAll('[data-testid^="nav-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(ids).toEqual(["nav-watchtower", "nav-inbox", "nav-runs", "nav-schedules", "nav-analytics"]);
  });

  it("groups Build items: Projects, Workflows, Skills, Providers in order", () => {
    const { container } = mount("/");
    const groups = Array.from(container.querySelectorAll('[data-slot="sidebar-group"]'));
    const build = groups.find(
      (g) => g.querySelector('[data-slot="sidebar-group-label"]')?.textContent?.trim() === "Build",
    );
    expect(build).toBeTruthy();
    const ids = Array.from(build!.querySelectorAll('[data-testid^="nav-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(ids).toEqual(["nav-projects", "nav-workflows", "nav-skills", "nav-providers"]);
  });

  it("marks the link matching the current route with aria-current=page", () => {
    const { container } = mount("/workflows");
    const q = within(container);
    const active = container.querySelector('[aria-current="page"]');
    expect(active).not.toBeNull();
    expect(q.getByTestId("nav-workflows").getAttribute("aria-current")).toBe("page");
    expect(q.getByTestId("nav-watchtower").getAttribute("aria-current")).toBeNull();
  });

  it("toggles the sidebar collapsed state on ⌘+B and persists via cookie", () => {
    mount("/");

    const wrapper = document.querySelector('[data-slot="sidebar-wrapper"]');
    expect(wrapper?.getAttribute("data-state")).toBe("expanded");

    act(() => {
      fireEvent.keyDown(window, { key: "b", metaKey: true });
    });
    expect(wrapper?.getAttribute("data-state")).toBe("collapsed");

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
  it("home (Watchtower)", () => {
    expect(crumbsFor("/", {})).toEqual([{ label: "Watchtower" }]);
  });

  it("inbox", () => {
    expect(crumbsFor("/inbox", {})).toEqual([{ label: "Inbox" }]);
  });

  it("workflows", () => {
    expect(crumbsFor("/workflows", {})).toEqual([{ label: "Workflows" }]);
  });

  it("runs list", () => {
    expect(crumbsFor("/runs", {})).toEqual([{ label: "Runs" }]);
  });

  it("run detail truncates the id to 8 chars", () => {
    expect(crumbsFor("/runs/abcdef1234567890", { id: "abcdef1234567890" })).toEqual([
      { label: "Runs", href: "/runs" },
      { label: "abcdef12" },
    ]);
  });
});
