// Backfill-failure surfacing: when the initial GET /api/events backfill
// errors, the operator must see a non-blocking, dismissible indicator in
// the feed area saying only live events are shown — with a retry that
// re-runs the backfill and clears the indicator on success. The SSE
// stream still opens (live-only mode stays useful).

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalFeed } from "../../src/components/GlobalFeed.tsx";
import { useGlobalEventStream } from "../../src/lib/useGlobalEventStream.ts";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.readyState = 2;
  }
  _open(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l(new Event("open"));
  }
}

function GlobalHook(): null {
  useGlobalEventStream({ eventSourceImpl: FakeEventSource as unknown as typeof EventSource, reconnectBaseMs: 5 });
  return null;
}

function mountFeed() {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <JotaiProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>
  );
  return render(
    <>
      <GlobalHook />
      <GlobalFeed />
    </>,
    { wrapper: Wrapper },
  );
}

describe("GlobalFeed — backfill failure indicator", () => {
  let mock: ReturnType<typeof installFetchMock>;
  /** Mutable switch: while true, GET /api/events returns 500. */
  const state = { backfillFails: true };

  beforeEach(() => {
    state.backfillFails = true;
    FakeEventSource.instances = [];
    mock = installFetchMock({}, ({ url }) => {
      if (/\/api\/events(\?|$)/.test(url)) {
        return state.backfillFails ? new Response("boom", { status: 500 }) : json([]);
      }
      if (/\/api\/runs/.test(url)) return json([]);
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    FakeEventSource.instances = [];
  });

  it("shows a dismissible live-only indicator when the backfill errors, still opens SSE, and retry clears it", async () => {
    mountFeed();

    // The indicator surfaces the failure: backfill failed, only live events shown.
    await waitFor(() => {
      expect(screen.getByText(/only live events/i)).toBeTruthy();
    });

    // Live-only mode still works: the SSE stream was opened despite the failure.
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    act(() => FakeEventSource.instances[0]?._open());

    // Retry affordance: re-runs the backfill; on success the indicator clears.
    state.backfillFails = false;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(screen.queryByText(/only live events/i)).toBeNull();
    });
  });

  it("the indicator is dismissible without retrying", async () => {
    mountFeed();
    await waitFor(() => {
      expect(screen.getByText(/only live events/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => {
      expect(screen.queryByText(/only live events/i)).toBeNull();
    });
  });
});
