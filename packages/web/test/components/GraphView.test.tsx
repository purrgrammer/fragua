// Tests for the GraphView component.
//
// What we cover:
//   1. Direct `svg` prop path — the component injects the document and
//      delegates clicks through `data-node-id`.
//   2. Fetch-by-runId path — the URL used MUST be the relative
//      `/api/pipelines/:id/graph.svg` string produced by the api helper.
//      This is the enforcement point for the "no absolute URLs" rule:
//      absolute URLs would hit Vite's dev server (5173) instead of the
//      swarm server (3000) and silently 404.
//   3. Malformed / empty SVG path → empty state (no throw, no raw error).
//   4. Fetch failure (404) → empty state, raw message stays out of the DOM.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { GraphView } from "../../src/components/GraphView.tsx";
import { createApiClient } from "../../src/lib/api.ts";
import { useDom } from "../setup.ts";

// Register happy-dom once for all describes in this file. `useDom` is a
// test-harness helper, not a React hook — the `use*` prefix is
// coincidental. The directive below MUST stay on a single line for Biome
// to attach it to the call on the next line.
// biome-ignore lint/correctness/useHookAtTopLevel: useDom is a test-harness helper, not a React hook; the use* prefix is coincidental.
useDom();

const SAMPLE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <g data-node-id="n1"><rect x="0" y="0" width="40" height="20"/></g>
  <g data-node-id="n2"><rect x="50" y="0" width="40" height="20"/></g>
</svg>
`;

describe("GraphView — svg prop path", () => {
  afterEach(() => cleanup());

  it("injects the SVG inside the wrapper and exposes node groups", () => {
    const { container } = render(<GraphView svg={SAMPLE_SVG} />);
    const host = within(container).getByTestId("graph-view");
    // Both node groups should be present in the DOM.
    expect(host.querySelector('[data-node-id="n1"]')).toBeTruthy();
    expect(host.querySelector('[data-node-id="n2"]')).toBeTruthy();
  });

  it("delegates clicks through [data-node-id] to onNodeClick", () => {
    const clicks: string[] = [];
    const { container } = render(<GraphView svg={SAMPLE_SVG} onNodeClick={(id) => clicks.push(id)} />);
    const host = within(container).getByTestId("graph-view");
    const node = host.querySelector('[data-node-id="n2"]') as HTMLElement | null;
    expect(node).toBeTruthy();
    // Click on a child — closest() should walk up to the [data-node-id].
    const child = node?.querySelector("rect") as HTMLElement | null;
    fireEvent.click(child ?? (node as HTMLElement));
    expect(clicks).toEqual(["n2"]);
  });

  it("renders the empty state (not a raw error) when the SVG is malformed", () => {
    const { container } = render(<GraphView svg={"not an svg at all"} />);
    expect(within(container).getByTestId("graph-empty")).toBeTruthy();
    // Raw payload must NOT be visible to the user.
    expect(container.textContent ?? "").not.toContain("not an svg at all");
  });
});

describe("GraphView — fetch-by-runId path", () => {
  afterEach(() => cleanup());

  function makeClientWith(fetchImpl: typeof fetch) {
    return createApiClient({ fetchImpl });
  }

  it("requests the RELATIVE /api/pipelines/:id/graph.svg URL (never absolute)", async () => {
    const captured: { url?: string } = {};
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured.url = typeof input === "string" ? input : input.toString();
      return new Response(SAMPLE_SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    }) as unknown as typeof fetch;
    const api = makeClientWith(fetchImpl);

    const { container } = render(<GraphView api={api} runId="abc" />);

    await waitFor(() => {
      expect(within(container).getByTestId("graph-view").querySelector('[data-node-id="n1"]')).toBeTruthy();
    });

    // The critical assertion: URL is relative, /api-prefixed, and never
    // absolute / localhost-qualified — see api.ts comment block for why.
    expect(captured.url).toBe("/api/pipelines/abc/graph.svg");
    expect(captured.url?.startsWith("/api/")).toBe(true);
    expect(captured.url).not.toMatch(/^https?:/);
    expect(captured.url).not.toContain("localhost");
  });

  it("on 404 renders the empty state and does NOT leak the raw error message", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const fetchImpl = (async () =>
        new Response("run not found", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch;
      const api = makeClientWith(fetchImpl);

      const { container } = render(<GraphView api={api} runId="missing" />);
      await waitFor(() => {
        expect(within(container).getByTestId("graph-empty")).toBeTruthy();
      });
      // Empty state shows the short runId for orientation, but not the
      // raw HTTP error text.
      const text = container.textContent ?? "";
      expect(text).toContain("No graph available");
      expect(text).not.toContain("404");
      expect(text).not.toContain("Not Found");
      expect(text).not.toContain("run not found");
    } finally {
      console.warn = origWarn;
    }
  });

  it("applies data-active to the selected node id", async () => {
    const fetchImpl = (async () =>
      new Response(SAMPLE_SVG, {
        status: 200,
        headers: { "content-type": "image/svg+xml" },
      })) as unknown as typeof fetch;
    const api = makeClientWith(fetchImpl);

    const { container } = render(<GraphView api={api} runId="r1" activeNodeId="n1" />);

    await waitFor(() => {
      const host = within(container).getByTestId("graph-view");
      const n1 = host.querySelector('[data-node-id="n1"]');
      expect(n1?.getAttribute("data-active")).toBe("true");
      // Other node must not be marked active.
      const n2 = host.querySelector('[data-node-id="n2"]');
      expect(n2?.getAttribute("data-active")).toBeNull();
    });
  });
});
