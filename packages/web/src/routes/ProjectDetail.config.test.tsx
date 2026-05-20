// Config-section tests for ProjectDetail — YAML / JSONC resolution and rendering.
// Kept in a separate file so useDom() lifecycle doesn't interfere with the
// tabs describe block in ProjectDetail.test.tsx.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { encodeProjectId } from "../lib/projectId.ts";
import { ProjectDetail } from "./ProjectDetail.tsx";

const TEST_CWD = "/projects/alpha";
const TEST_ENC = encodeProjectId(TEST_CWD);

function installFetchWithConfig(opts: { yamlConfig?: string | null; jsoncConfig?: string | null }): void {
  const { yamlConfig, jsoncConfig } = opts;
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
      if (url.includes("config.jsonc")) {
        if (jsoncConfig === null) return new Response("not found", { status: 404 });
        if (jsoncConfig !== undefined)
          return new Response(jsoncConfig, { status: 200, headers: { "Content-Type": "text/plain" } });
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/skills")) {
      return new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/agents")) {
      return new Response(JSON.stringify({ agents: [] }), {
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
          <Route path="/projects/:cwdEnc" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectDetail · Config tab", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders summary from .swarm/config.yaml", async () => {
    installFetchWithConfig({
      yamlConfig: `bootstrap: "bun install --frozen-lockfile"\ndefaults:\n  provider: anthropic\n`,
      jsoncConfig: null,
    });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    const section = await waitFor(() => within(container).getByTestId("project-config-section"));
    const bootstrapRow = await waitFor(() => within(section).getByTestId("project-config-bootstrap"));
    expect(bootstrapRow.textContent).toContain("bun install --frozen-lockfile");
    const llmRow = await waitFor(() => within(section).getByTestId("project-config-llm"));
    expect(llmRow.textContent).toContain("anthropic");
  });

  test("falls back to .swarm/config.jsonc when YAML is absent (legacy)", async () => {
    installFetchWithConfig({
      yamlConfig: null,
      jsoncConfig: `{ "bootstrap": "legacy-cmd" }`,
    });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    const bootstrapRow = await waitFor(() => within(container).getByTestId("project-config-bootstrap"));
    expect(bootstrapRow.textContent).toContain("legacy-cmd");
  });

  test("YAML takes precedence when both files exist", async () => {
    installFetchWithConfig({
      yamlConfig: `bootstrap: "yaml-cmd"`,
      jsoncConfig: `{ "bootstrap": "jsonc-cmd" }`,
    });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    const bootstrapRow = await waitFor(() => within(container).getByTestId("project-config-bootstrap"));
    expect(bootstrapRow.textContent).toContain("yaml-cmd");
    expect(bootstrapRow.textContent).not.toContain("jsonc-cmd");
  });

  test("shows unparsable state when YAML body is malformed", async () => {
    installFetchWithConfig({
      yamlConfig: `key: [unclosed bracket`,
      jsoncConfig: null,
    });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    await waitFor(() => within(container).getByTestId("project-config-unparsable"));
  });

  test("shows empty state when both config files are absent", async () => {
    installFetchWithConfig({ yamlConfig: null, jsoncConfig: null });
    const { container } = renderAt(`/projects/${TEST_ENC}`);
    await waitFor(() => within(container).getByTestId("project-config-empty"));
  });
});
