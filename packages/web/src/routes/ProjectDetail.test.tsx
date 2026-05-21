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

interface UrlCapture {
  /** Last URL hit per endpoint family. Useful for tab tests that need
   *  to assert on query string shape without intercepting every fetch. */
  skills?: string;
}

function installFetch(opts: InstallOpts = {}, capture?: UrlCapture): void {
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
    if (url.includes("/skills")) {
      if (capture) capture.skills = url;
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

  test("renders Runs, Workflows, Files, Skills triggers in order", async () => {
    installFetch();
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    const tabs = await waitFor(() => within(container).getByTestId("project-tabs"));
    const triggers = within(tabs).getAllByRole("tab");
    expect(triggers.map((t) => t.textContent?.trim())).toEqual(["Runs", "Workflows", "Files", "Skills"]);
  });

  test("workflows tab is the active panel when ?tab=workflows", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".fragua/workflows/ci-gate.yaml", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=workflows`);
    const wfSection = await waitFor(() => within(container).getByTestId("project-workflows-section"));
    expect(within(wfSection).getByTestId("project-workflows-table")).not.toBeNull();
    expect(within(container).queryByTestId("project-runs-table")).toBeNull();
  });

  test("activating Workflows tab updates the URL search param to tab=workflows", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".fragua/workflows/ci-gate.yaml", sha: "deadbeefcafe", cwd: TEST_CWD }],
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

  test("RunComposer renders inside the Runs tab panel", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".fragua/workflows/ci-gate.yaml", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    // Default tab is `runs` (no ?tab= param). The composer must live inside the
    // active runs panel, not the workflows section.
    const tabs = await waitFor(() => within(container).getByTestId("project-tabs"));
    const composer = await waitFor(() => within(tabs).getByTestId("run-composer-form"));
    // Radix renders all tabpanels; the composer must sit inside the *active* one,
    // and the workflows section must not contain it.
    const ownerPanel = composer.closest('[role="tabpanel"]');
    expect(ownerPanel).not.toBeNull();
    expect(ownerPanel?.getAttribute("data-state")).toBe("active");
    const wfSection = within(container).queryByTestId("project-workflows-section");
    if (wfSection) expect(within(wfSection).queryByTestId("run-composer-form")).toBeNull();
  });

  test("RunComposer is not rendered inside the Workflows tab panel", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".fragua/workflows/ci-gate.yaml", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=workflows`);
    const wfSection = await waitFor(() => within(container).getByTestId("project-workflows-section"));
    expect(within(wfSection).queryByTestId("run-composer-form")).toBeNull();
  });

  test("Skills tab requests project-only scope", async () => {
    const capture: UrlCapture = {};
    installFetch({}, capture);
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=skills`, undefined);
    await waitFor(() => within(container).getByTestId("project-skills-section"));
    await waitFor(() => {
      expect(capture.skills).toBeDefined();
    });
    const url = capture.skills ?? "";
    expect(url).toContain(`project_cwd=${encodeURIComponent(TEST_CWD)}`);
    expect(url).toContain("scope=project_only");
  });

  test("links project workflows to /workflows/:name with the project cwd", async () => {
    installFetch({
      workflows: [{ name: "ci-gate", path: ".fragua/workflows/ci-gate.yaml", sha: "deadbeefcafe", cwd: TEST_CWD }],
    });
    const { container } = renderAt(`/projects/${TEST_ENC}?tab=workflows`);
    const link = (await waitFor(() =>
      within(container).getByTestId("project-workflow-link-ci-gate"),
    )) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain(`cwd=${encodeURIComponent(TEST_CWD)}`);
    expect(link.getAttribute("href")).toContain("/workflows/ci-gate");
  });
});
