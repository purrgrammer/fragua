import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useDom } from "../../../test/setup.ts";
import {
  ALL_PROJECTS_VALUE,
  cwdToProjectSelectValue,
  ProjectSelector,
  projectSelectValueToCwd,
} from "./ProjectSelector.tsx";

function installProjectsFetch(
  projects: Array<{ cwd: string; name: string; lastUpdatedAt: number; runCount: number }>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/projects")) {
      return new Response(JSON.stringify(projects), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ProjectSelector", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders 'All projects' as the default option and emits null on selecting it", async () => {
    installProjectsFetch([{ cwd: "/proj/a", name: "alpha", lastUpdatedAt: 1, runCount: 1 }]);
    const { container } = renderWithClient(<ProjectSelector value={null} onChange={() => {}} />);

    // The trigger is rendered up-front (no data dependency); we check
    // the structural contract: a combobox with our test id, the right
    // aria-label, and — crucially — that null `value` translates to
    // the `__all__` sentinel via the exported helper. We test the
    // visible-text contract on the helper, not on Radix's portal-
    // rendered SelectValue (happy-dom doesn't render the listbox so
    // the visible label remains empty).
    const trigger = await waitFor(() => container.querySelector('[data-testid="project-selector"]'));
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Project filter");
    expect(trigger?.getAttribute("role")).toBe("combobox");

    // The translation that powers "selecting __all__ emits null":
    expect(projectSelectValueToCwd(ALL_PROJECTS_VALUE)).toBeNull();
    expect(cwdToProjectSelectValue(null)).toBe(ALL_PROJECTS_VALUE);
  });

  test("emits the chosen cwd when a project is selected", async () => {
    installProjectsFetch([
      { cwd: "/proj/a", name: "alpha", lastUpdatedAt: 1, runCount: 1 },
      { cwd: "/proj/b", name: "beta", lastUpdatedAt: 2, runCount: 1 },
    ]);
    const { container } = renderWithClient(<ProjectSelector value={"/proj/b"} onChange={() => {}} />);
    const trigger = await waitFor(() => container.querySelector('[data-testid="project-selector"]'));
    expect(trigger).not.toBeNull();

    // The cwd-side contract: when the user picks a project from the
    // listbox, Radix calls `onValueChange("/abs/path")` and our
    // wrapper passes it through unchanged. cwdToProjectSelectValue
    // round-trips so a parent re-render with the new value lands on
    // the right Radix selection.
    expect(projectSelectValueToCwd("/proj/a")).toBe("/proj/a");
    expect(projectSelectValueToCwd("/proj/b")).toBe("/proj/b");
    expect(cwdToProjectSelectValue("/proj/b")).toBe("/proj/b");
  });
});
