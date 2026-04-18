// Route-level tests for `/skills` (list) and `/skills/:name` (detail).

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { SkillDetail, SkillSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function mount(client: ReturnType<typeof createTestQueryClient>, path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

function summary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: "pdf",
    description: "Extract PDFs",
    location: "/abs/pdf/SKILL.md",
    skill_dir: "/abs/pdf",
    sha256: "a".repeat(64),
    bytes: 123,
    scope: "user",
    source_dir: "/abs",
    ...overrides,
  };
}

describe("Skills routes", () => {
  useDom();

  describe("list route", () => {
    afterEach(() => cleanup());

    it("renders one row per skill with name + description + scope + source", async () => {
      const rows: SkillSummary[] = [
        summary({ name: "pdf", description: "Extract PDFs", scope: "user" }),
        summary({ name: "csv", description: "Parse CSVs", scope: "project", source_dir: "/repo/.agents/skills" }),
      ];
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.list().queryKey, rows);

      const { container } = mount(client, "/skills");
      const q = within(container);
      await waitFor(() => expect(q.queryByTestId("skills-loading")).toBeNull());
      expect(q.getByTestId("skill-row-pdf")).toBeTruthy();
      expect(q.getByTestId("skill-row-csv")).toBeTruthy();
    });

    it("renders empty state when no skills are installed", async () => {
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.list().queryKey, [] as SkillSummary[]);

      const { container } = mount(client, "/skills");
      await waitFor(() => expect(within(container).getByTestId("skills-empty")).toBeTruthy());
    });

    it("hides disabled skills by default but exposes a toggle", async () => {
      const rows: SkillSummary[] = [
        summary({ name: "active" }),
        summary({ name: "hidden", disabled_reason: "skills.trust_project=false" }),
      ];
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.list().queryKey, rows);

      const { container } = mount(client, "/skills");
      const q = within(container);
      await waitFor(() => expect(q.getByTestId("skill-row-active")).toBeTruthy());
      expect(q.queryByTestId("skill-row-hidden")).toBeNull();
      const toggle = q.getByTestId("skills-toggle-disabled");
      expect(toggle.textContent).toContain("Show 1 disabled");
      toggle.click();
      await waitFor(() => {
        const row = q.getByTestId("skill-row-hidden");
        expect(row.getAttribute("data-disabled")).toBe("true");
        expect(row.getAttribute("title")).toContain("trust_project");
      });
    });

    it("renders 'all disabled' empty state when every skill is hidden", async () => {
      const rows: SkillSummary[] = [summary({ name: "only-one", disabled_reason: "config" })];
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.list().queryKey, rows);

      const { container } = mount(client, "/skills");
      await waitFor(() => expect(within(container).getByTestId("skills-all-disabled")).toBeTruthy());
    });
  });

  describe("detail route", () => {
    afterEach(() => cleanup());

    it("renders body + metadata when the skill exists", async () => {
      const detail: SkillDetail = { ...summary({ name: "pdf" }), body: "# PDF\n\ninstructions" };
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.detail("pdf").queryKey, detail);

      const { container } = mount(client, "/skills/pdf");
      await waitFor(() => expect(within(container).getByTestId("skill-body")).toBeTruthy());
      expect(within(container).getByTestId("skill-body").textContent).toContain("instructions");
    });

    it("shows not-found when the server returns 404", async () => {
      const origWarn = console.warn;
      console.warn = () => {};
      const mock = installFetchMock({
        "/api/skills/nope": () => new Response("404", { status: 404, statusText: "Not Found" }),
      });
      try {
        const { container } = mount(createTestQueryClient(), "/skills/nope");
        await waitFor(() => expect(within(container).getByTestId("skill-not-found")).toBeTruthy());
      } finally {
        mock.restore();
        console.warn = origWarn;
      }
    });

    it("renders `Used in recent runs` when the server includes usage", async () => {
      const detail: SkillDetail = {
        ...summary({ name: "pdf" }),
        body: "body",
        usage: { runs: ["run-a", "run-b"], count: 3 },
      };
      const client = createTestQueryClient();
      client.setQueryData(queries.skills.detail("pdf").queryKey, detail);

      const { container } = mount(client, "/skills/pdf");
      await waitFor(() => expect(within(container).getByTestId("skill-usage-runs")).toBeTruthy());
      const listItems = within(container).getByTestId("skill-usage-runs").querySelectorAll("li");
      expect(listItems.length).toBe(2);
    });
  });
});
