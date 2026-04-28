// Control Center live-update coverage.
//
// Wires the Home route to a fake fetch + a fake EventSource and
// verifies that an SSE lifecycle event causes Inbox / Running / Activity
// to refetch and render the new state — the contract that powers the
// "no-poll" dashboard. If this regresses, operators see stale data
// until they reload (the bug we just fixed by adding reconnect to
// useEventSource).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { useGlobalEventStream } from "../../src/lib/useGlobalEventStream.ts";
import { Home } from "../../src/routes/Home.tsx";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

// Minimal fake EventSource — same shape as the one in useEventSource.test.ts.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
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
    this.closed = true;
    this.readyState = 2;
  }
  _open(): void {
    this.readyState = 1;
    for (const l of this.listeners.get("open") ?? []) l(new Event("open"));
  }
  _emit(payload: unknown): void {
    const ev = new MessageEvent("message", { data: JSON.stringify(payload) });
    for (const l of this.listeners.get("message") ?? []) l(ev as unknown as Event);
  }
}

interface FakeRun {
  runId: string;
  status: "running" | "paused" | "queued" | "success" | "fail" | "canceled";
  runStatus: "running" | "paused_hitl" | "paused_provider_error" | "queued" | "completed" | "halted" | "cancelled";
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  eventCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  title?: string;
  input?: string;
}

const baseRun = (over: Partial<FakeRun> & Pick<FakeRun, "runId" | "status" | "runStatus">): FakeRun => ({
  startedAt: "2026-04-28T18:00:00.000Z",
  eventCount: 1,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...over,
});

/** Test API: returns whatever the mutable `state.runs` is when called.
 *  Tests advance state, then fire an SSE event, then waitFor the UI
 *  to reflect the new rows. */
function homeFetchMock(state: { runs: FakeRun[] }) {
  return installFetchMock({}, ({ url }) => {
    if (/\/api\/events(\?|$)/.test(url)) return json([]); // backfill
    if (/\/api\/health/.test(url)) return json({ ok: true, daemon: { pid: 1, port: 0, startedAt: "x" } });
    if (/\/api\/runs(\?|$)/.test(url)) {
      // Filter `runs` by query params so each section sees its slice.
      const u = new URL(url, "http://test");
      const statusFilter = u.searchParams.get("status");
      const wanted = statusFilter ? new Set(statusFilter.split(",")) : null;
      const out = wanted ? state.runs.filter((r) => wanted.has(r.runStatus)) : state.runs;
      return json(out);
    }
    return new Response("not found", { status: 404 });
  });
}

function MountedHome(): JSX.Element {
  // Replicates App.tsx: GlobalFeedHost runs at root, Home below.
  useGlobalEventStream({ eventSourceImpl: FakeEventSource as unknown as typeof EventSource });
  return <Home />;
}

function mountHome() {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<MountedHome />, { wrapper: Wrapper });
}

async function waitForFakeSse(): Promise<FakeEventSource> {
  await waitFor(() => {
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
  });
  const es = FakeEventSource.instances[0]!;
  act(() => es._open());
  return es;
}

describe("Control Center live updates", () => {
  useDom();
  let mock: ReturnType<typeof installFetchMock>;
  const state: { runs: FakeRun[] } = { runs: [] };

  beforeEach(() => {
    state.runs = [];
    mock = homeFetchMock(state);
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    FakeEventSource.instances = [];
  });

  it("fact.run_paused_hitl pushes a row into Inbox without a reload", async () => {
    const { container } = mountHome();
    await waitFor(() => {
      // Initial load completed: we got past the loading skeletons.
      expect(container.querySelectorAll("[data-testid='global-feed']").length).toBeGreaterThan(0);
    });
    const es = await waitForFakeSse();

    // Inbox is initially empty (or showing its empty state).
    expect(container.textContent).toContain("All clear");

    // Server transitions: a new run is now in paused_hitl.
    state.runs = [
      baseRun({ runId: "01rrun01paused", status: "paused", runStatus: "paused_hitl", workflow: "hitl-tools" }),
    ];
    act(() => {
      es._emit({
        runId: "01rrun01paused",
        seq: 13,
        type: "fact.run_paused_hitl",
        writer: "daemon",
        payload: { nodeId: "review", label: "Approve?", options: [] },
        ts: Date.now(),
      });
    });

    // Inbox refetches off the SSE invalidation; the new row appears.
    await waitFor(() => {
      expect(container.textContent).toContain("01rrun01paused".slice(0, 4));
    });
    expect(container.textContent).not.toContain("All clear");
  });

  it("fact.run_started pushes a row into Running without a reload", async () => {
    const { container } = mountHome();
    await waitFor(() => {
      expect(container.querySelectorAll("[data-testid='global-feed']").length).toBeGreaterThan(0);
    });
    const es = await waitForFakeSse();

    expect(container.textContent).toContain("Nothing running");

    state.runs = [
      baseRun({ runId: "01rrun02running", status: "running", runStatus: "running", workflow: "smoke-sleep" }),
    ];
    act(() => {
      es._emit({
        runId: "01rrun02running",
        seq: 2,
        type: "fact.run_started",
        writer: "daemon",
        payload: { startNode: "start" },
        ts: Date.now(),
      });
    });

    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });
    expect(container.textContent).toMatch(/01rr/);
  });

  it("fact.run_completed removes a run from Running and surfaces in Activity", async () => {
    // Seed: one running run on initial load.
    state.runs = [
      baseRun({ runId: "01rrun03liverun", status: "running", runStatus: "running", workflow: "smoke-sleep" }),
    ];
    const { container } = mountHome();
    await waitFor(() => {
      expect(container.querySelectorAll("[data-testid='global-feed']").length).toBeGreaterThan(0);
    });
    const es = await waitForFakeSse();
    // Wait for Running to actually populate from the seed.
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });

    // The run completes server-side; subsequent list calls return an empty
    // running set.
    state.runs = [];
    act(() => {
      es._emit({
        runId: "01rrun03liverun",
        seq: 18,
        type: "fact.run_completed",
        writer: "daemon",
        payload: { finalNode: "done" },
        ts: Date.now(),
      });
    });

    // Running re-empties; Activity gets a "completed" row from the SSE.
    await waitFor(() => {
      expect(container.textContent).toContain("Nothing running");
    });
    expect(container.textContent).toContain("completed");
  });
});
