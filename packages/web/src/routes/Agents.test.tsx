// Agents list page — empty state + list rendering. Mirrors
// Skills.test.tsx; the detail page is covered separately.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { Agents } from "./Agents.tsx";

function installAgentsFetch(payload: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/agents")) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithProviders(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/agents"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Agents", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders the empty-state banner when discovery returns no agents", async () => {
    installAgentsFetch({ agents: [] });
    const { container } = renderWithProviders(<Agents />);
    const empty = await waitFor(() => within(container).getByTestId("agents-empty"));
    expect(empty.textContent).toContain(".agents/agents/");
  });

  test("renders rows with only name, description, and scope on /agents", async () => {
    installAgentsFetch({
      agents: [
        {
          locId: "abc",
          name: "reviewer",
          description: "Reviews diffs.",
          model: "claude-sonnet-4",
          location: "/projects/a/.agents/agents/reviewer.md",
          sha256: "0".repeat(64),
          bytes: 50,
          scope: "project",
          source_dir: "/projects/a/.agents/agents",
          project_cwd: "/projects/a",
        },
        {
          locId: "def",
          name: "researcher",
          description: "Reads docs.",
          location: "/home/u/.agents/agents/researcher.md",
          sha256: "0".repeat(64),
          bytes: 30,
          scope: "user",
          source_dir: "/home/u/.agents/agents",
        },
      ],
    });
    const { container } = renderWithProviders(<Agents />);
    const table = await waitFor(() => within(container).getByTestId("agents-table"));
    const reviewerRow = within(table).getByTestId("agent-row-reviewer");
    expect(reviewerRow.textContent).toContain("reviewer");
    expect(reviewerRow.textContent).toContain("Reviews diffs.");
    expect(reviewerRow.textContent).toContain("project");
    expect(reviewerRow.textContent).not.toContain("claude-sonnet-4");
    const researcherRow = within(table).getByTestId("agent-row-researcher");
    expect(researcherRow.textContent).toContain("user");
    expect(table.textContent).not.toContain("Model");
    expect(table.textContent).not.toContain("Project");
  });
});
