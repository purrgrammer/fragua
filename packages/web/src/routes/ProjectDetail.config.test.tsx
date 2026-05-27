// Config-section tests for ProjectDetail — YAML resolution and rendering.
// Kept in a separate file so useDom() lifecycle doesn't interfere with the
// tabs describe block in ProjectDetail.test.tsx.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { useDom } from "../../test/setup.ts";
import { ProjectDetail } from "./ProjectDetail.tsx";

const TEST_CWD = "/projects/alpha";
const TEST_PROJECT_ID = "019e4f5b-0000-7000-8000-0000000000bb";

function installFetchWithConfig(opts: { yamlConfig?: string | null }): void {
  const { yamlConfig } = opts;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/projects/") && url.includes("/tree")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/projects/") && url.includes("/blob")) {
      if (url.includes("config.yaml")) {
        if (yamlConfig === null) return new Response("not found", { status: 404 });
        if (yamlConfig !== undefined)
          return new Response(yamlConfig, { status: 200, headers: { "Content-Type": "text/plain" } });
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }
    if (/\/projects(\?|$)/.test(url)) {
      return new Response(
        JSON.stringify([
          {
            projectId: TEST_PROJECT_ID,
            name: "alpha",
            cwd: TEST_CWD,
            cwdHint: TEST_CWD,
            lastUpdatedAt: 1,
            runCount: 0,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/skills")) {
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/workflows")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/runs")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderAt(path: string): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectDetail · Config tab", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders summary from .fragua/config.yaml", async () => {
    installFetchWithConfig({
      yamlConfig: `bootstrap: "bun install --frozen-lockfile"\ndefaults:\n  provider: anthropic\n`,
    });
    const { container } = renderAt(`/projects/${TEST_PROJECT_ID}`);
    const section = await waitFor(() => within(container).getByTestId("project-config-section"));
    const bootstrapRow = await waitFor(() => within(section).getByTestId("project-config-bootstrap"));
    expect(bootstrapRow.textContent).toContain("bun install --frozen-lockfile");
    const llmRow = await waitFor(() => within(section).getByTestId("project-config-llm"));
    expect(llmRow.textContent).toContain("anthropic");
  });

  test("shows unparsable state when YAML body is malformed", async () => {
    installFetchWithConfig({
      yamlConfig: `key: [unclosed bracket`,
    });
    const { container } = renderAt(`/projects/${TEST_PROJECT_ID}`);
    await waitFor(() => within(container).getByTestId("project-config-unparsable"));
  });

  test("shows empty state when the config file is absent", async () => {
    installFetchWithConfig({ yamlConfig: null });
    const { container } = renderAt(`/projects/${TEST_PROJECT_ID}`);
    await waitFor(() => within(container).getByTestId("project-config-empty"));
  });

  test("renders auto-title / max-loops / bootstrap-timeout-ms from kebab keys", async () => {
    installFetchWithConfig({
      yamlConfig: `auto-title: false\nmax-loops: 7\nbootstrap-timeout-ms: 30000\n`,
    });
    const { container } = renderAt(`/projects/${TEST_PROJECT_ID}`);
    const autoTitleRow = await waitFor(() => within(container).getByTestId("project-config-auto-title"));
    expect(autoTitleRow.textContent).toContain("Off");
    const maxLoopsRow = await waitFor(() => within(container).getByTestId("project-config-max-loops"));
    expect(maxLoopsRow.textContent).toContain("7");
    const bootstrapTimeoutRow = await waitFor(() => within(container).getByTestId("project-config-bootstrap-timeout"));
    expect(bootstrapTimeoutRow.textContent).toBeTruthy();
  });
});
