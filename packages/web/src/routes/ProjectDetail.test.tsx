// Tab strip on /projects/:cwdEnc — proves Workflows is a tab (not a
// sibling section), the URL ?tab= param round-trips, and project
// workflow links carry the project cwd.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { encodeProjectId } from "../lib/projectId.ts";
import { ProjectDetail } from "./ProjectDetail.tsx";

const TEST_CWD = "/projects/alpha";
const TEST_ENC = encodeProjectId(TEST_CWD);

interface InstallOpts {
  workflows?: Array<{ name: string; label?: string; path: string; sha: string; cwd?: string }>;
  runs?: unknown[];
}

function installFetch(opts: InstallOpts = {}): void {
  const workflows = opts.workflows ?? [];
  const runs = opts.runs ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/projects/") && url.includes("/tree")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/projects/") && url.includes("/blob")) {
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/workflows")) {
      return new Response(JSON.stringify(workflows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/runs")) {
      return new Response(JSON.stringify(runs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderAt(initialEntry: string, probe?: { current: URLSearchParams | null }): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe(): null {
    const [sp] = useSearchParams();
    if (probe) probe.current = sp;
    return null;
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/projects/:cwdEnc"
            element={
              <>
                <ProjectDetail />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectDetail · tabs", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders Runs, Workflows, Files, Skills, Agents triggers in order", async () => {
    installFetch();
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    const tabs = await waitFor(() => within(container).getByTestId("project-tabs"));
    const triggers = within(tabs).getAllByRole("tab");
    expect(triggers.map((t) => t.textContent?.trim())).toEqual(["Runs", "Workflows", "Files", "Skills", "Agents"]);
  });

  test("workflows tab is the active panel when ?tab=workflows", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".swarm/workflows/ci-gate.dot", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=workflows`);
    const wfSection = await waitFor(() => within(container).getByTestId("project-workflows-section"));
    expect(within(wfSection).getByTestId("project-workflows-table")).not.toBeNull();
    expect(within(container).queryByTestId("project-runs-table")).toBeNull();
  });

  test("activating Workflows tab updates the URL search param to tab=workflows", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".swarm/workflows/ci-gate.dot", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const probe: { current: URLSearchParams | null } = { current: null };
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=runs`, probe);
    const trigger = await waitFor(() => within(container).getByTestId("project-tab-workflows"));
    // Radix Tabs activates on pointerDown + click; happy-dom needs both fired
    // explicitly because synthetic `click` alone doesn't dispatch pointer events.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(probe.current?.get("tab")).toBe("workflows");
    });
  });

  test("links project workflows to /workflows/:name with the project cwd", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".swarm/workflows/ci-gate.dot", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=workflows`);
    const link = (await waitFor(() =>
      within(container).getByTestId("project-workflow-link-ci-gate"),
    )) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain(`cwd=${encodeURIComponent(TEST_CWD)}`);
    expect(link.getAttribute("href")).toContain("/workflows/ci-gate");
  });
});
