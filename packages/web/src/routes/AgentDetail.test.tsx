// AgentDetail back-link smoke test. The detail page must offer a way
// back to /agents — operators land here from the list and need a
// reversible breadcrumb (matching the same affordance on RunDetail).

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { AgentDetail } from "./AgentDetail.tsx";

const AGENT_DETAIL_PAYLOAD = {
  agent: {
    locId: "abc",
    name: "reviewer",
    description: "Reviews PRs",
    location: "/projects/a/.agents/agents/reviewer.md",
    sha256: "0".repeat(64),
    bytes: 200,
    scope: "project" as const,
    source_dir: "/projects/a/.agents/agents",
    project_cwd: "/projects/a",
  },
  body: "# reviewer\n\nYou review PRs.",
};

function installAgentFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/agents/abc")) {
      return new Response(JSON.stringify(AGENT_DETAIL_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithProviders(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/agents/abc"]}>
        <Routes>
          <Route path="/agents/:locId" element={<AgentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AgentDetail", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders a back link to /agents above the header", async () => {
    installAgentFetch();
    const { container } = renderWithProviders();
    // Wait until the detail query has resolved and the header rendered.
    await waitFor(() => within(container).getByTestId("agent-detail-name"));
    const back = within(container).getByTestId("agent-detail-back");
    expect(back.tagName).toBe("A");
    expect(back.getAttribute("href")).toBe("/agents");
    expect(back.textContent).toContain("all agents");
  });
});
