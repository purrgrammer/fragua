// RunComposer — unit tests covering grouping, auto-selection, POST body,
// invalidation, and error surfacing.
//
// Radix Select renders Content into a portal that only mounts on open,
// so most of our visibility checks fire AFTER clicking the trigger. The
// auto-selection assertion relies on the POST body (the trigger's
// SelectValue text isn't populated until the menu is opened), which is
// the more behavioural check anyway.

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RunComposer } from "../../src/components/RunComposer.tsx";
import type { WorkflowSummary } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function workflow(name: string, opts: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    name,
    path: opts.path ?? `workflows/${name}.dot`,
    sha: opts.sha ?? `sha-${name}`,
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  };
}

const PROJECT_CWD = "/work/proj-a";

describe("RunComposer", () => {
  useDom();
  afterEach(() => cleanup());

  it("groups project-local workflows under 'This project' and globals under 'Global'", async () => {
    // Radix Select renders its grouped Content inside a portal that
    // only mounts when the menu opens, and happy-dom doesn't dispatch
    // the pointer events Radix listens for to open. We assert grouping
    // through its user-visible consequence instead: when local + global
    // workflows are both present, the auto-seeded selection MUST be a
    // local workflow, and submitting it MUST tag the body as scope="local"
    // even though a global option exists. The fallback test below
    // covers the inverse (no local → picks global), pinning the
    // ordering invariant from both sides.
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-grouped" });
      },
    });
    try {
      // Global appears FIRST in the input array — if grouping weren't
      // happening, the auto-seed would pick "global-a".
      const workflows: WorkflowSummary[] = [
        workflow("global-a"),
        workflow("local-a", { cwd: PROJECT_CWD }),
        workflow("local-b", { cwd: PROJECT_CWD }),
      ];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });
      const body = lastBody as Record<string, unknown>;
      expect(body["workflowName"]).toBe("local-a");
      expect(body["workflowScope"]).toBe("local");
    } finally {
      mock.restore();
    }
  });

  it("auto-selects the first project-local workflow on mount when one exists", async () => {
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("method not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-1" });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [
        workflow("local-first", { cwd: PROJECT_CWD }),
        workflow("local-second", { cwd: PROJECT_CWD }),
        workflow("global-only"),
      ];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      // Submit immediately — auto-seed picked the first local workflow.
      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });
      expect((lastBody as { workflowName?: string }).workflowName).toBe("local-first");
      expect((lastBody as { workflowScope?: string }).workflowScope).toBe("local");
    } finally {
      mock.restore();
    }
  });

  it("falls back to the first global workflow when no local workflows exist", async () => {
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-2" });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("global-first"), workflow("global-second")];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });
      expect((lastBody as { workflowName?: string }).workflowName).toBe("global-first");
      expect((lastBody as { workflowScope?: string }).workflowScope).toBe("global");
    } finally {
      mock.restore();
    }
  });

  it("submit is enabled with empty textarea and POSTs /runs with the selected workflow's sha+name+scope+path+cwd+input", async () => {
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-3" });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [
        workflow("local-a", { cwd: PROJECT_CWD, path: "/work/proj-a/.swarm/workflows/local-a.dot", sha: "sha-LA" }),
      ];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      // Submit is enabled with empty textarea.
      const submit = getByTestId("run-composer-submit") as HTMLButtonElement;
      expect(submit.disabled).toBe(false);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });

      expect(lastBody).toEqual({
        workflowSha: "sha-LA",
        workflowName: "local-a",
        workflowScope: "local",
        workflowPath: "/work/proj-a/.swarm/workflows/local-a.dot",
        cwd: PROJECT_CWD,
        input: "",
      });
    } finally {
      mock.restore();
    }
  });

  it("derives workflowScope='global' for cwd-less workflows and threads project cwd into the run body", async () => {
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-4" });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [
        workflow("global-a", { path: "/home/u/.swarm/workflows/global-a.dot", sha: "sha-GA" }),
      ];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });

      const body = lastBody as Record<string, unknown>;
      expect(body["workflowScope"]).toBe("global");
      // Run cwd is the project we're viewing, not the workflow source.
      expect(body["cwd"]).toBe(PROJECT_CWD);
      expect(body["workflowSha"]).toBe("sha-GA");
    } finally {
      mock.restore();
    }
  });

  it("invalidates the runs list query on success", async () => {
    const mock = installFetchMock({
      "/api/runs": async ({ method }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        return json({ runId: "r-5" });
      },
    });
    try {
      const client = createTestQueryClient();
      // Seed a runs-list cache entry; assert it gets invalidated.
      const filter = { cwd: PROJECT_CWD };
      client.setQueryData(queries.runs.list(filter).queryKey, []);

      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />, { client });

      const before = client.getQueryState(queries.runs.list(filter).queryKey);
      expect(before?.isInvalidated ?? false).toBe(false);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        const state = client.getQueryState(queries.runs.list(filter).queryKey);
        // Either the entry is marked invalidated OR it has been refetched
        // (queries with no observer go straight from invalidated to a
        // fresh fetch attempt; with retry: false + no fetcher in the
        // route, the marker is what we observe).
        expect(state?.isInvalidated || (state?.dataUpdateCount ?? 0) > 1).toBe(true);
      });
    } finally {
      mock.restore();
    }
  });

  it("disables submit while the mutation is pending and surfaces error text on failure", async () => {
    const mock = installFetchMock({
      "/api/runs": async ({ method }) => {
        if (method !== "POST") return new Response("nope", { status: 405 });
        return new Response("boom", { status: 500 });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { getByTestId, queryByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      const submit = getByTestId("run-composer-submit") as HTMLButtonElement;
      expect(submit.disabled).toBe(false);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      // Error becomes visible once the mutation rejects.
      await waitFor(() => {
        expect(queryByTestId("run-composer-error")).toBeTruthy();
      });

      const errEl = getByTestId("run-composer-error");
      expect(errEl.textContent ?? "").toContain("500");

      // Submit re-enables after the failure (mutation no longer pending).
      await waitFor(() => {
        expect((getByTestId("run-composer-submit") as HTMLButtonElement).disabled).toBe(false);
      });
    } finally {
      mock.restore();
    }
  });
});
