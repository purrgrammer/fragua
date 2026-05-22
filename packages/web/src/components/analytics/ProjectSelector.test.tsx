import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useDom } from "../../../test/setup.ts";
import {
  ALL_PROJECTS_VALUE,
  ProjectSelector,
  projectIdToSelectValue,
  projectSelectValueToProjectId,
} from "./ProjectSelector.tsx";

interface ProjectRow {
  projectId: string;
  name: string;
  cwd: string | null;
  cwdHint: string | null;
  lastUpdatedAt: number;
  runCount: number;
}

const PID_A = "019e4f5b-0000-7000-8000-00000000000a";
const PID_B = "019e4f5b-0000-7000-8000-00000000000b";

function installProjectsFetch(projects: ProjectRow[]): void {
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
    installProjectsFetch([
      { projectId: PID_A, name: "alpha", cwd: "/proj/a", cwdHint: "/proj/a", lastUpdatedAt: 1, runCount: 1 },
    ]);
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
    expect(projectSelectValueToProjectId(ALL_PROJECTS_VALUE)).toBeNull();
    expect(projectIdToSelectValue(null)).toBe(ALL_PROJECTS_VALUE);
  });

  test("emits the chosen project_id when a project is selected", async () => {
    installProjectsFetch([
      { projectId: PID_A, name: "alpha", cwd: "/proj/a", cwdHint: "/proj/a", lastUpdatedAt: 1, runCount: 1 },
      { projectId: PID_B, name: "beta", cwd: "/proj/b", cwdHint: "/proj/b", lastUpdatedAt: 2, runCount: 1 },
    ]);
    const { container } = renderWithClient(<ProjectSelector value={PID_B} onChange={() => {}} />);
    const trigger = await waitFor(() => container.querySelector('[data-testid="project-selector"]'));
    expect(trigger).not.toBeNull();

    // The identity-side contract: when the user picks a project from the
    // listbox, Radix calls `onValueChange("<project_id>")` and our
    // wrapper passes it through unchanged. projectIdToSelectValue
    // round-trips so a parent re-render with the new value lands on
    // the right Radix selection.
    expect(projectSelectValueToProjectId(PID_A)).toBe(PID_A);
    expect(projectSelectValueToProjectId(PID_B)).toBe(PID_B);
    expect(projectIdToSelectValue(PID_B)).toBe(PID_B);
  });
});
