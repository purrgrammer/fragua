// Smoke test for the web scaffold: render <App/> with a stubbed ApiClient
// and assert the health badge transitions from "connecting…" → "connected"
// on a successful `/health` response. Failure path is a separate test so a
// regression pinpoints which branch broke.
//
// Why no `screen` import:
//   `@testing-library/dom` initializes its global `screen` object at module
//   load, capturing `document.body` at that moment. Since we register the
//   DOM lazily (see `./setup.ts` for why), `screen` is guaranteed-broken
//   at load time. We sidestep this by using the `{ container }` returned
//   by `render()` and `within(container)` — both resolve at call time.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { App } from "../src/App.tsx";
import type { ApiClient } from "../src/lib/api.ts";
import { useDom } from "./setup.ts";

function stubClient(impl: ApiClient["health"]): ApiClient {
  return { health: impl };
}

describe("App", () => {
  useDom();

  afterEach(() => {
    cleanup();
  });

  it("renders the connected badge when /health returns ok", async () => {
    const client = stubClient(async () => ({ ok: true }));
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    // Immediate loading state is visible until the effect resolves.
    expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("loading");

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("connected");
    });
    expect(q.getByTestId("health-badge").textContent).toContain("connected");
  });

  it("renders the error badge when /health rejects", async () => {
    const client = stubClient(async () => {
      throw new Error("boom");
    });
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
    });
    const badge = q.getByTestId("health-badge");
    expect(badge.textContent).toContain("error");
    // The underlying error message rides along via the title attr for
    // hover diagnostics; assert it's surfaced so regressions are loud.
    expect(badge.getAttribute("title")).toBe("boom");
  });

  it("renders the error badge when /health reports ok:false", async () => {
    const client = stubClient(async () => ({ ok: false }));
    const { container } = render(<App apiClient={client} />);
    const q = within(container);

    await waitFor(() => {
      expect(q.getByTestId("health-badge").getAttribute("data-status")).toBe("error");
    });
  });
});
