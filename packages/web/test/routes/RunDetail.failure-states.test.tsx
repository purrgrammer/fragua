// Failure-state surfacing on the run view: SSE disconnects, message
// fetch failures, and 404-vs-5xx on the detail query must all be
// visible to the operator — never rendered as silence.

import { act, cleanup, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { RunDetail as RunDetailT, RunMessageRow } from "../../src/lib/api.ts";
import { queries } from "../../src/lib/queries.ts";
import { createRoutes } from "../../src/lib/router.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

// ─── FakeEventSource with error injection ────────────────────────
// Like the fake in RunDetail.test.tsx but adds `_error(readyState)` so
// tests can simulate a transient SSE failure (readyState=1 → browser
// retrying internally → useEventSource surfaces status "error").

let _currentFakeEs: FakeEventSource | null = null;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  private listeners: Map<string, Array<(ev: Event) => void>> = new Map();

  constructor(public readonly url: string) {
    _currentFakeEs = this;
  }

  addEventListener(type: string, listener: (ev: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  close(): void {
    this.readyState = 2;
    if (_currentFakeEs === this) _currentFakeEs = null;
  }

  _open(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l(new Event("open"));
  }

  /** Fire an `error` event at the given readyState. readyState=1 is the
   * transient path (browser auto-retrying); readyState=2 is permanent. */
  _error(readyState: 0 | 1 | 2 = 1): void {
    this.readyState = readyState;
    for (const l of this.listeners.get("error") ?? []) l(new Event("error"));
  }
}

function installFakeEventSource(): { restore: () => void; getEs: () => FakeEventSource | null } {
  const g = globalThis as { [key: string]: unknown };
  const original = g["EventSource"];
  g["EventSource"] = FakeEventSource;
  return {
    restore() {
      g["EventSource"] = original;
      _currentFakeEs = null;
    },
    getEs() {
      return _currentFakeEs;
    },
  };
}

function mount(client: ReturnType<typeof createTestQueryClient>, path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  return renderWithClient(<RouterProvider router={router} />, { client });
}

function runningDetail(runId: string): RunDetailT {
  return {
    runId,
    workflowName: "demo",
    startedAt: "2024-01-01T00:00:00Z",
    status: "running",
    lastEventSeq: 1,
    nodes: [],
    selectedEdges: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

describe("RunDetail — failure states are surfaced, not swallowed", () => {
  afterEach(() => cleanup());

  it("shows a reconnecting badge when the SSE stream errors on a running run", async () => {
    const detail = runningDetail("run-sse-err");
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.detail("run-sse-err").queryKey, detail);
    const mock = installFetchMock(
      {
        "/api/runs/run-sse-err/messages": () => json([]),
        "/api/runs/run-sse-err/steps": () => json([]),
        "/api/runs/run-sse-err": () => json(detail),
      },
      () => json([]),
    );
    const fakeEs = installFakeEventSource();
    try {
      const { container } = mount(client, "/runs/run-sse-err");
      const q = within(container);

      // SSE opens for the running run; live pill appears.
      await waitFor(() => expect(fakeEs.getEs()).toBeTruthy());
      await act(async () => {
        fakeEs.getEs()!._open();
      });
      await waitFor(() => {
        expect(q.getByTestId("detail-live-pill")).toBeTruthy();
      });

      // Transient SSE error (readyState=1 → browser retrying). The run is
      // still running server-side; the page must say it's reconnecting
      // instead of silently dropping the live pill.
      await act(async () => {
        fakeEs.getEs()!._error(1);
      });
      await waitFor(() => {
        expect(q.getByTestId("detail-reconnecting-pill")).toBeTruthy();
      });
      expect(q.queryByTestId("detail-live-pill")).toBeNull();

      // Recovery: the badge yields back to the live pill.
      await act(async () => {
        fakeEs.getEs()!._open();
      });
      await waitFor(() => {
        expect(q.getByTestId("detail-live-pill")).toBeTruthy();
      });
      expect(q.queryByTestId("detail-reconnecting-pill")).toBeNull();
    } finally {
      mock.restore();
      fakeEs.restore();
    }
  });

  it("shows an error EmptyState in the conversation view when the messages fetch fails", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const detail = runningDetail("run-msg-err");
    const client = createTestQueryClient();
    client.setQueryData(queries.runs.detail("run-msg-err").queryKey, detail);
    const mock = installFetchMock(
      {
        "/api/runs/run-msg-err/messages": () =>
          new Response("boom", { status: 500, statusText: "Internal Server Error" }),
        "/api/runs/run-msg-err/steps": () => json([]),
        "/api/runs/run-msg-err": () => json(detail),
      },
      () => json([]),
    );
    const fakeEs = installFakeEventSource();
    try {
      const { container } = mount(client, "/runs/run-msg-err");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("conversation-region")).toBeTruthy();
      });
      // The failed fetch must produce a visible error state — not a
      // blank conversation pane with only a console.warn.
      await waitFor(() => {
        expect(q.getByTestId("conversation-messages-error")).toBeTruthy();
      });
    } finally {
      mock.restore();
      fakeEs.restore();
      console.warn = origWarn;
    }
  });

  it("keeps stale messages visible and shows an inline failure note when a refetch fails", () => {
    const messages: RunMessageRow[] = [
      {
        ordinal: 1,
        nodeId: "fix",
        iteration: 0,
        content: {
          role: "assistant",
          content: [{ type: "text", text: "stale but precious" }],
          timestamp: 0,
        } as RunMessageRow["content"],
      },
    ];
    const { container } = renderWithClient(<RunConversation messages={messages} messagesError={true} />);
    const q = within(container);
    // The transcript is NOT wiped…
    expect(container.textContent ?? "").toContain("stale but precious");
    expect(q.queryByTestId("conversation-messages-error")).toBeNull();
    // …and the failure is still surfaced inline.
    expect(q.getByTestId("conversation-messages-error-inline")).toBeTruthy();
  });

  it("renders 'Run not found' for a 404 on the detail query", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock(
      {
        "/api/runs/run-gone": () => new Response("not found", { status: 404, statusText: "Not Found" }),
        "/api/runs/run-gone/messages": () => json([]),
      },
      () => json([]),
    );
    try {
      const { container } = mount(createTestQueryClient(), "/runs/run-gone");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-not-found")).toBeTruthy();
      });
      expect((container.textContent ?? "").toLowerCase()).toContain("not found");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });

  it("renders a retry-suggesting error (not 'not found') for a 500 on the detail query", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    const mock = installFetchMock(
      {
        "/api/runs/run-5xx": () => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
        "/api/runs/run-5xx/messages": () => json([]),
      },
      () => json([]),
    );
    try {
      const { container } = mount(createTestQueryClient(), "/runs/run-5xx");
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("detail-error")).toBeTruthy();
      });
      expect(q.queryByTestId("detail-not-found")).toBeNull();
      expect((container.textContent ?? "").toLowerCase()).not.toContain("run not found");
    } finally {
      mock.restore();
      console.warn = origWarn;
    }
  });
});
