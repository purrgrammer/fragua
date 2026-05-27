import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { RunsList } from "./RunsList.tsx";

// Stub fetch so the runs list query resolves to an empty array — that's
// the path that renders the empty state.
function installEmptyRunsFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/runs")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function renderWithClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("RunsList — empty state", () => {
  afterEach(() => cleanup());

  test("renders an icon inside the empty state, mirroring the /inbox empty-state structure", async () => {
    installEmptyRunsFetch();
    const { container } = renderWithClient(<RunsList />);

    const empty = await waitFor(() => within(container).getByTestId("runs-empty"));

    // Inbox's empty state passes an `aria-hidden` icon node (size-6) — the
    // EmptyState primitive wraps it in a <div class="text-sw-muted"
    // aria-hidden="true">…</div>. The runs empty state should expose the
    // same icon slot so both routes look visually identical except for the
    // icon and copy.
    const iconWrapper = empty.querySelector('[aria-hidden="true"]');
    expect(iconWrapper).not.toBeNull();
    const svg = iconWrapper?.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
