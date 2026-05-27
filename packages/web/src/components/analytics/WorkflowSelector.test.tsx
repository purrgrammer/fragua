import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { useDom } from "../../../test/setup.ts";
import {
  ALL_WORKFLOWS_VALUE,
  WorkflowSelector,
  workflowSelectionToValue,
  workflowSelectValueToSelection,
} from "./WorkflowSelector.tsx";

interface WorkflowEntry {
  scope: "global" | "local";
  name: string;
  cwd: string | null;
  runCount: number;
  lastActivityMs: number;
}

function installWorkflowsFetch(rows: WorkflowEntry[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/analytics/workflows")) {
      return new Response(JSON.stringify({ workflows: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("WorkflowSelector", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders the trigger with the right contract regardless of fetch state", async () => {
    installWorkflowsFetch([{ scope: "global", name: "research", cwd: null, runCount: 5, lastActivityMs: 1 }]);
    const { container } = renderWithClient(<WorkflowSelector value={null} onChange={() => {}} cwd={null} />);

    const trigger = await waitFor(() => container.querySelector('[data-testid="workflow-selector"]'));
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute("aria-label")).toBe("Workflow filter");
    expect(trigger?.getAttribute("role")).toBe("combobox");
  });

  test("scope:name encoding round-trips for globals (no cwd)", () => {
    expect(workflowSelectionToValue(null)).toBe(ALL_WORKFLOWS_VALUE);
    expect(workflowSelectionToValue({ scope: "global", name: "research", cwd: null })).toBe("global:research");
    expect(workflowSelectValueToSelection("global:research")).toEqual({
      scope: "global",
      name: "research",
      cwd: null,
    });
    expect(workflowSelectValueToSelection(ALL_WORKFLOWS_VALUE)).toBeNull();
  });

  test("local selection carries its owning cwd through the round-trip", () => {
    // The cwd is URL-encoded so paths with colons (Windows drives) or
    // slashes can ride the Radix value string safely. Decoding is
    // exact-match against the original.
    const sel = { scope: "local" as const, name: "research", cwd: "/Users/me/fragua" };
    const v = workflowSelectionToValue(sel);
    expect(v).toBe("local:research:%2FUsers%2Fme%2Ffragua");
    expect(workflowSelectValueToSelection(v)).toEqual(sel);
  });

  test("rejects malformed values gracefully", () => {
    expect(workflowSelectValueToSelection("nope")).toBeNull();
    expect(workflowSelectValueToSelection("badscope:research")).toBeNull();
    expect(workflowSelectValueToSelection("global:")).toBeNull();
    expect(workflowSelectValueToSelection(":research")).toBeNull();
    // A trailing ':' (empty cwd segment) is ambiguous — reject so a
    // bug upstream is loud rather than silently round-tripping to a
    // null cwd that nobody asked for.
    expect(workflowSelectValueToSelection("local:research:")).toBeNull();
  });
});
