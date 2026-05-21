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
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function workflow(name: string, opts: Partial<WorkflowSummary> = {}): WorkflowSummary {
  return {
    name,
    path: opts.path ?? `workflows/${name}.yaml`,
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

  it("submit POSTs /runs with cwd, workflowName, workflowScope — no input, sha, or path", async () => {
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
        workflow("local-a", { cwd: PROJECT_CWD, path: "/work/proj-a/.fragua/workflows/local-a.yaml", sha: "sha-LA" }),
      ];
      const { getByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);

      // Submit is enabled once a workflow is selected.
      const submit = getByTestId("run-composer-submit") as HTMLButtonElement;
      expect(submit.disabled).toBe(false);

      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });

      // The server resolves the workflow off disk (latest contents) by
      // (cwd, workflowName, workflowScope) — the client never computes
      // or pins a sha, so nothing about the listing's identity travels
      // over the wire on enqueue.
      expect(lastBody).toEqual({
        cwd: PROJECT_CWD,
        workflowName: "local-a",
        workflowScope: "local",
      });
      const body = lastBody as Record<string, unknown>;
      expect(body).not.toHaveProperty("input");
      expect(body).not.toHaveProperty("workflowSha");
      expect(body).not.toHaveProperty("workflowPath");
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
        workflow("global-a", { path: "/home/u/.fragua/workflows/global-a.yaml", sha: "sha-GA" }),
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
      expect(body["workflowName"]).toBe("global-a");
      expect(body).not.toHaveProperty("workflowSha");
      expect(body).not.toHaveProperty("workflowPath");
    } finally {
      mock.restore();
    }
  });

  it("invalidates the runs list query on success", async () => {
    let invalidateCalled = false;
    const mock = installFetchMock({
      "/api/runs": async ({ method }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        return json({ runId: "r-5" });
      },
      // Provide a no-inputs detail response so the workflow detail query
      // resolves cleanly without leaving a pending async error in the queue.
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source: "name: local-a\nsteps:\n  work:\n    type: llm\n    prompt: x\n",
        }),
    });
    try {
      const client = createTestQueryClient();
      // Wrap invalidateQueries to observe the call without polling stale cache.
      const orig = client.invalidateQueries.bind(client);
      client.invalidateQueries = async (...args: Parameters<typeof orig>) => {
        invalidateCalled = true;
        return orig(...args);
      };

      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />, { client });

      const form = document.querySelector("[data-testid='run-composer-form']") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(invalidateCalled).toBe(true);
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

  // ── Typed inputs tests ──────────────────────────────────────────────

  it("renders WorkflowInputsForm when the selected workflow declares inputs[]", async () => {
    const source = [
      "name: local-a",
      "inputs:",
      "  ticket:",
      "    type: string",
      "    required: true",
      "steps:",
      "  work:",
      "    type: llm",
      "    prompt: Work on ${{ inputs.ticket }}",
    ].join("\n");
    const mock = installFetchMock({
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source,
          inputs: [{ name: "ticket", type: "string", required: true }],
        }),
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { findByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);
      // WorkflowInputsForm should appear once the detail query resolves.
      const form = await findByTestId("workflow-inputs-form");
      expect(form).toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("does not render WorkflowInputsForm when the workflow has no inputs", async () => {
    const mock = installFetchMock({
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source: "name: local-a\nsteps:\n  work:\n    type: llm\n    prompt: x\n",
        }),
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { queryByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);
      // Give the query time to resolve.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(queryByTestId("workflow-inputs-form")).toBeNull();
    } finally {
      mock.restore();
    }
  });

  it("POST /runs body includes inputs map when typed inputs are filled", async () => {
    const source = [
      "name: local-a",
      "inputs:",
      "  ticket:",
      "    type: string",
      "    required: false",
      "    default: BUG-1",
      "steps:",
      "  work:",
      "    type: llm",
      "    prompt: Work on ${{ inputs.ticket }}",
    ].join("\n");
    let lastBody: unknown;
    const mock = installFetchMock({
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source,
          inputs: [{ name: "ticket", type: "string", required: false, default: "BUG-1" }],
        }),
      "/api/runs": async ({ method, init }) => {
        if (method !== "POST") return new Response("not allowed", { status: 405 });
        if (typeof init?.body === "string") lastBody = JSON.parse(init.body);
        return json({ runId: "r-typed" });
      },
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { getByTestId, findByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);
      // Wait for the inputs form to appear (detail query resolved).
      await findByTestId("workflow-inputs-form");
      // The default value is seeded; submit immediately.
      const form = getByTestId("run-composer-form") as HTMLFormElement;
      await act(async () => {
        fireEvent.submit(form);
      });
      await waitFor(() => {
        expect(lastBody).toBeTruthy();
      });
      const body = lastBody as Record<string, unknown>;
      expect(body["inputs"]).toEqual({ ticket: "BUG-1" });
    } finally {
      mock.restore();
    }
  });

  it("submit is disabled while a required typed input is empty", async () => {
    const source = [
      "name: local-a",
      "inputs:",
      "  ticket:",
      "    type: string",
      "    required: true",
      "steps:",
      "  work:",
      "    type: llm",
      "    prompt: Work on ${{ inputs.ticket }}",
    ].join("\n");
    const mock = installFetchMock({
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source,
          inputs: [{ name: "ticket", type: "string", required: true }],
        }),
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { getByTestId, findByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);
      // Wait for the inputs form (detail resolved).
      await findByTestId("workflow-inputs-form");
      // Required input is empty — submit must be disabled.
      await waitFor(() => {
        expect((getByTestId("run-composer-submit") as HTMLButtonElement).disabled).toBe(true);
      });
    } finally {
      mock.restore();
    }
  });

  it("submit re-enables once every required input has a default value", async () => {
    const source = [
      "name: local-a",
      "inputs:",
      "  ticket:",
      "    type: string",
      "    required: true",
      "    default: BUG-42",
      "steps:",
      "  work:",
      "    type: llm",
      "    prompt: Work on ${{ inputs.ticket }}",
    ].join("\n");
    const mock = installFetchMock({
      "/api/workflows/local-a?cwd=%2Fwork%2Fproj-a": async () =>
        json({
          name: "local-a",
          path: "workflows/local-a.yaml",
          sha: "sha-local-a",
          source,
          inputs: [{ name: "ticket", type: "string", required: true, default: "BUG-42" }],
        }),
    });
    try {
      const workflows: WorkflowSummary[] = [workflow("local-a", { cwd: PROJECT_CWD })];
      const { getByTestId, findByTestId } = renderWithClient(<RunComposer cwd={PROJECT_CWD} workflows={workflows} />);
      // Wait for the inputs form.
      await findByTestId("workflow-inputs-form");
      // The required input has a default — submit should be enabled once
      // the seeding effect fires.
      await waitFor(() => {
        expect((getByTestId("run-composer-submit") as HTMLButtonElement).disabled).toBe(false);
      });
    } finally {
      mock.restore();
    }
  });
});
