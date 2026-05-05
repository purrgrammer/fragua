// SkillDetail back-link smoke test. The detail page must offer a way
// back to /skills — same affordance as RunDetail's "← all runs".

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { SkillDetail } from "./SkillDetail.tsx";

const SKILL_SUMMARY = {
  locId: "abc",
  name: "frontend",
  description: "React patterns",
  location: "/projects/a/.agents/skills/frontend/SKILL.md",
  skill_dir: "/projects/a/.agents/skills/frontend",
  sha256: "0".repeat(64),
  bytes: 100,
  scope: "project" as const,
  source_dir: "/projects/a/.agents/skills",
  project_cwd: "/projects/a",
};

const SKILL_DETAIL_PAYLOAD = {
  skill: SKILL_SUMMARY,
  frontmatter: {},
  body: "# frontend\n\nReact patterns.",
};

const SKILL_TREE_PAYLOAD = {
  tree: [{ path: "SKILL.md", type: "file" as const, size: 100 }],
  truncated: false,
};

function installSkillFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/skills/abc/tree")) {
      return new Response(JSON.stringify(SKILL_TREE_PAYLOAD), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/skills/abc/file")) {
      // FileViewer fetches the auto-selected SKILL.md once the tree resolves.
      return new Response("# frontend\n", { status: 200, headers: { "Content-Type": "text/markdown" } });
    }
    if (url.includes("/api/skills/abc")) {
      return new Response(JSON.stringify(SKILL_DETAIL_PAYLOAD), {
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
      <MemoryRouter initialEntries={["/skills/abc"]}>
        <Routes>
          <Route path="/skills/:locId" element={<SkillDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SkillDetail", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders a back link to /skills above the header", async () => {
    installSkillFetch();
    const { container } = renderWithProviders();
    // Wait until the detail query has resolved and the header rendered.
    await waitFor(() => within(container).getByTestId("skill-detail-name"));
    const back = within(container).getByTestId("skill-detail-back");
    expect(back.tagName).toBe("A");
    expect(back.getAttribute("href")).toBe("/skills");
    expect(back.textContent).toContain("all skills");
  });
});
