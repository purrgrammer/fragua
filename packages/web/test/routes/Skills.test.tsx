// Route-level tests for `/skills` (list) and `/skills/:name` (detail).

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { type ApiClient, ApiError, type SkillDetail, type SkillSummary } from "../../src/lib/api.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { useDom } from "../setup.ts";

function makeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const baseUrl = overrides.baseUrl ?? "/api";
  const eventsUrl = overrides.getPipelineEventsUrl ?? ((id: string) => `${baseUrl}/pipelines/${id}/events`);
  return {
    baseUrl,
    health: async () => ({ ok: true }),
    listPipelines: async () => [],
    listWorkflows: async () => [],
    getPipeline: async (id: string) => ({
      runId: id,
      startedAt: "2024-01-01T00:00:00Z",
      status: "unknown" as const,
      lastEventSeq: 0,
      nodes: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getPipelineEvents: async () => ({ events: [], lastSeq: 0 }),
    getPipelineSteps: async () => [],
    listSkills: async () => [],
    getSkill: async () => {
      throw new Error("getSkill not stubbed");
    },
    getPipelineEventsUrl: eventsUrl,
    pipelineEventsUrl: eventsUrl,
    ...overrides,
  };
}

function mount(api: ApiClient, path: string) {
  const router = createMemoryRouter(createRoutes({ api }), { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
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
        summary({ name: "csv", description: "Parse CSVs", scope: "project", source_dir: "/repo/.swarm/skills" }),
      ];
      const api = makeClient({ listSkills: async () => rows });
      const { container } = mount(api, "/skills");
      const q = within(container);
      await waitFor(() => expect(q.queryByTestId("skills-loading")).toBeNull());
      expect(q.getByTestId("skill-row-pdf")).toBeTruthy();
      expect(q.getByTestId("skill-row-csv")).toBeTruthy();
    });

    it("renders empty state when no skills are installed", async () => {
      const api = makeClient({ listSkills: async () => [] });
      const { container } = mount(api, "/skills");
      await waitFor(() => expect(within(container).getByTestId("skills-empty")).toBeTruthy());
    });

    it("greys out disabled skills and surfaces disabled_reason", async () => {
      const rows: SkillSummary[] = [summary({ name: "hidden", disabled_reason: "skills.trust_project=false" })];
      const api = makeClient({ listSkills: async () => rows });
      const { container } = mount(api, "/skills");
      await waitFor(() => {
        const row = within(container).getByTestId("skill-row-hidden");
        expect(row.getAttribute("data-disabled")).toBe("true");
        expect(row.getAttribute("title")).toContain("trust_project");
      });
    });
  });

  describe("detail route", () => {
    afterEach(() => cleanup());

    it("renders body + metadata when the skill exists", async () => {
      const detail: SkillDetail = { ...summary({ name: "pdf" }), body: "# PDF\n\ninstructions" };
      const api = makeClient({ getSkill: async () => detail });
      const { container } = mount(api, "/skills/pdf");
      await waitFor(() => expect(within(container).getByTestId("skill-body")).toBeTruthy());
      expect(within(container).getByTestId("skill-body").textContent).toContain("instructions");
    });

    it("shows not-found when the server returns 404", async () => {
      const api = makeClient({
        getSkill: async () => {
          throw new ApiError("404", 404, "/api/skills/nope");
        },
      });
      const { container } = mount(api, "/skills/nope");
      await waitFor(() => expect(within(container).getByTestId("skill-not-found")).toBeTruthy());
    });

    it("renders `Used in recent runs` when the server includes usage", async () => {
      const detail: SkillDetail = {
        ...summary({ name: "pdf" }),
        body: "body",
        usage: { runs: ["run-a", "run-b"], count: 3 },
      };
      const api = makeClient({ getSkill: async () => detail });
      const { container } = mount(api, "/skills/pdf");
      await waitFor(() => expect(within(container).getByTestId("skill-usage-runs")).toBeTruthy());
      const listItems = within(container).getByTestId("skill-usage-runs").querySelectorAll("li");
      expect(listItems.length).toBe(2);
    });
  });
});
