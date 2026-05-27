// Confirms the SkillsList component scopes its request via
// `?project_cwd=` and drops the Project column when used in a
// per-project context (the column would be redundant since every row
// would show the same value).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { SkillsList } from "./skills-list.tsx";

function captureFetch(): { last: () => string | undefined } {
  let lastUrl: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    lastUrl = url;
    return new Response(
      JSON.stringify({
        skills: [
          {
            locId: "abc",
            name: "frontend",
            description: "React patterns",
            location: "/projects/a/.agents/skills/frontend/SKILL.md",
            skill_dir: "/projects/a/.agents/skills/frontend",
            sha256: "0".repeat(64),
            bytes: 100,
            scope: "project",
            source_dir: "/projects/a/.agents/skills",
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

describe("SkillsList", () => {
  afterEach(() => cleanup());

  test("passes ?project_cwd= when scoped to a single project", async () => {
    const fetcher = captureFetch();
    const { container } = renderWithProviders(<SkillsList projectCwd="/projects/a" />);
    await waitFor(() => within(container).getByTestId("skills-list-table"));
    expect(fetcher.last()).toContain(`/skills?project_cwd=${encodeURIComponent("/projects/a")}`);
  });

  test("appends &scope=project_only when projectOnly is set", async () => {
    const fetcher = captureFetch();
    const { container } = renderWithProviders(<SkillsList projectCwd="/projects/a" projectOnly />);
    await waitFor(() => within(container).getByTestId("skills-list-table"));
    const url = fetcher.last() ?? "";
    expect(url).toContain(`project_cwd=${encodeURIComponent("/projects/a")}`);
    expect(url).toContain("scope=project_only");
  });

  test("Project column is dropped when scoped to a project", async () => {
    captureFetch();
    const { container } = renderWithProviders(<SkillsList projectCwd="/projects/a" />);
    const table = await waitFor(() => within(container).getByTestId("skills-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Project");
    expect(headers).toContain("Name");
    expect(headers).toContain("Scope");
  });

  test("Scope column is dropped when projectOnly is set", async () => {
    captureFetch();
    const { container } = renderWithProviders(<SkillsList projectCwd="/projects/a" projectOnly />);
    const table = await waitFor(() => within(container).getByTestId("skills-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).not.toContain("Scope");
    expect(headers).toContain("Name");
    expect(headers).toContain("Description");
  });

  test("Project column is shown in the global view (no projectCwd prop)", async () => {
    captureFetch();
    const { container } = renderWithProviders(<SkillsList />);
    const table = await waitFor(() => within(container).getByTestId("skills-list-table"));
    const headers = Array.from(table.querySelectorAll("thead th")).map((h) => h.textContent?.trim());
    expect(headers).toContain("Project");
  });
});
