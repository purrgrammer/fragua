// Skills list page — empty state + list rendering. The router-driven
// detail navigation is exercised by the SkillDetail tests; here we
// only confirm the row shape so a contract regression on the server
// surfaces in CI.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { Skills } from "./Skills.tsx";

function installSkillsFetch(payload: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/skills")) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithProviders(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/skills"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Skills", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders the empty-state banner when discovery returns no skills", async () => {
    installSkillsFetch({ skills: [] });
    const { container } = renderWithProviders(<Skills />);
    const empty = await waitFor(() => within(container).getByTestId("skills-empty"));
    expect(empty).not.toBeNull();
    // Empty state copy guides operators to the right path.
    expect(empty.textContent).toContain("SKILL.md");
    expect(empty.textContent).toContain(".agents/skills/");
  });

  test("renders a row per skill with name link, scope, and project basename", async () => {
    installSkillsFetch({
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
        {
          locId: "def",
          name: "pdf",
          description: "PDF helpers",
          location: "/home/u/.agents/skills/pdf/SKILL.md",
          skill_dir: "/home/u/.agents/skills/pdf",
          sha256: "0".repeat(64),
          bytes: 100,
          scope: "user",
          source_dir: "/home/u/.agents/skills",
        },
      ],
    });
    const { container } = renderWithProviders(<Skills />);
    const table = await waitFor(() => within(container).getByTestId("skills-table"));
    // Each row carries `data-testid="skill-row-<name>"` — the link
    // inside is the navigation handle.
    const frontendRow = within(table).getByTestId("skill-row-frontend");
    expect(frontendRow.textContent).toContain("frontend");
    expect(frontendRow.textContent).toContain("React patterns");
    expect(frontendRow.textContent).toContain("project");
    // Project column shows the cwd's basename.
    expect(frontendRow.textContent).toContain("a");
    const pdfRow = within(table).getByTestId("skill-row-pdf");
    expect(pdfRow.textContent).toContain("user");
    // User-scope rows render — for project — as the dash placeholder.
    expect(pdfRow.textContent).toContain("—");
  });
});
