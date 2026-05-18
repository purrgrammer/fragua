import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDom } from "../../../test/setup.ts";
import { AgentsList } from "./agents-list.tsx";

function captureFetch(): { last: () => string | undefined } {
  let lastUrl: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    lastUrl = url;
    return new Response(
      JSON.stringify({
        agents: [
          {
            locId: "xyz",
            name: "reviewer",
            description: "Code review agent",
            location: "/projects/a/.agents/agents/reviewer.md",
            sha256: "0".repeat(64),
            bytes: 200,
            scope: "project",
            source_dir: "/projects/a/.agents/agents",
            project_cwd: "/projects/a",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { last: () => lastUrl };
}

function renderWithProviders(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AgentsList", () => {
  useDom();
  afterEach(() => cleanup());

  test("Scope column is dropped when projectOnly is set", async () => {
    captureFetch();
    const { container } = renderWithProviders(<AgentsList projectCwd="/projects/a" projectOnly />);
    const table = await waitFor(() => within(container).getByTestId("agents-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Scope");
    expect(headers).toContain("Name");
    expect(headers).toContain("Description");
  });

  test("Scope column is shown in the global view (no projectCwd prop)", async () => {
    captureFetch();
    const { container } = renderWithProviders(<AgentsList />);
    const table = await waitFor(() => within(container).getByTestId("agents-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).toContain("Scope");
  });

  test("Project column is dropped when scoped to a project", async () => {
    captureFetch();
    const { container } = renderWithProviders(<AgentsList projectCwd="/projects/a" />);
    const table = await waitFor(() => within(container).getByTestId("agents-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Project");
    expect(headers).toContain("Scope");
  });
});
