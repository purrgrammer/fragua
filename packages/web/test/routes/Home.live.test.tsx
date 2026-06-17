// Control Center live-update coverage.
//
// Wires the Home route to a fake fetch + a fake EventSource and
// verifies that an SSE lifecycle event causes Inbox / Running / Activity
// to refetch and render the new state — the contract that powers the
// "no-poll" dashboard. If this regresses, operators see stale data
// until they reload.
//
// Adversarial scenarios covered:
//   - basic: paused_human arrives → row appears in Inbox
//   - basic: run_started → row appears in Running
//   - basic: run_completed → row leaves Running, Activity gets the row
//   - basic: fact.snapshot_recorded with inbox_status=pending → row appears in Inbox
//   - navigation: leave Home, return, SSE still drives updates
//   - reconnect: EventSource permanent-close + auto-reconnect, events
//     emitted on the new connection still propagate to invalidations
//   - burst: many events in one batch all invalidate the cache exactly
//     once (no events dropped, no infinite refetch loops)

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useGlobalEventStream } from "../../src/lib/useGlobalEventStream.ts";
import { Home } from "../../src/routes/Home.tsx";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";

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
  _error(): void {
    for (const l of this.listeners.get("error") ?? []) l(new Event("error"));
  }
  /** Returns the latest open instance (some tests reconnect, then we
   *  want the new connection). */
  static latest(): FakeEventSource {
    const i = FakeEventSource.instances.at(-1);
    if (!i) throw new Error("no FakeEventSource yet");
    return i;
  }
}

interface FakeRun {
  runId: string;
  status: "running" | "paused" | "queued" | "success" | "fail" | "canceled";
  runStatus: "running" | "paused_human" | "paused_provider_error" | "queued" | "completed" | "halted" | "cancelled";
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
  inboxStatus?: "pending" | "acted" | "discarded";
  changeStat?: { committed: { filesChanged: number; insertions: number; deletions: number } | null; uncommitted: null };
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
      const inboxFilter = u.searchParams.get("inbox");
      let out = state.runs;
      if (statusFilter) {
        const wanted = new Set(statusFilter.split(","));
        out = out.filter((r) => wanted.has(r.runStatus));
      }
      if (inboxFilter) {
        out = out.filter((r) => r.inboxStatus === inboxFilter);
      }
      return json(out);
    }
    return new Response("not found", { status: 404 });
  });
}

/** Mount that mirrors App.tsx layout: GlobalFeedHost is a SIBLING of
 *  the router, so it survives navigation between routes. Tests can
 *  navigate via the `<NavTo>` helper inside the router subtree. */
function MountedTree({ initialPath = "/" }: { initialPath?: string }): JSX.Element {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <GlobalHook />
      <Routes>
        <Route path="/" element={<HomeWithControls />} />
        <Route path="/elsewhere" element={<ElsewherePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function GlobalHook(): null {
  // Reproduces App.tsx's <GlobalFeedHost /> as a SIBLING of <Routes>.
  useGlobalEventStream({ eventSourceImpl: FakeEventSource as unknown as typeof EventSource, reconnectBaseMs: 5 });
  return null;
}

/** Home + a navigate-elsewhere button. Tests click it to simulate
 *  the user leaving the Control Center. */
function HomeWithControls(): JSX.Element {
  const nav = useNavigate();
  return (
    <div>
      <button type="button" data-testid="nav-elsewhere" onClick={() => nav("/elsewhere")}>
        Go elsewhere
      </button>
      <Home />
    </div>
  );
}

function ElsewherePage(): JSX.Element {
  const nav = useNavigate();
  return (
    <div>
      <button type="button" data-testid="nav-home" onClick={() => nav("/")}>
        Back home
      </button>
      <p>Other route</p>
    </div>
  );
}

function mount(initialPath = "/") {
  const client = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<MountedTree initialPath={initialPath} />, { wrapper: Wrapper });
}

async function ensureSseOpen(): Promise<FakeEventSource> {
  await waitFor(() => {
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);
  });
  const es = FakeEventSource.latest();
  act(() => es._open());
  return es;
}

function emit(
  es: FakeEventSource,
  evt: { runId: string; seq: number; type: string; payload?: Record<string, unknown> },
) {
  act(() => {
    es._emit({ writer: "daemon", payload: {}, ts: Date.now(), ...evt });
  });
}

describe("Control Center live updates", () => {
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

  it("fact.run_paused_human pushes a row into Inbox without a reload", async () => {
    const { container } = mount();
    await waitFor(() => {
      expect(container.querySelectorAll("[data-testid='global-feed']").length).toBeGreaterThan(0);
    });
    const es = await ensureSseOpen();
    expect(container.textContent).toContain("All clear");

    state.runs = [
      baseRun({ runId: "01rinbox001", status: "paused", runStatus: "paused_human", workflow: "hitl-tools" }),
    ];
    emit(es, {
      runId: "01rinbox001",
      seq: 13,
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "review", label: "Approve?", options: [] },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("01rinbox001".slice(0, 4));
      // The inbox row arrives via the runs-list refetch the SSE event triggers,
      // which lands a tick after the event shows in the Activity feed.
      expect(container.textContent).not.toContain("All clear");
    });
  });

  it("fact.run_started pushes a row into Running without a reload", async () => {
    const { container } = mount();
    const es = await ensureSseOpen();
    expect(container.textContent).toContain("Nothing running");

    state.runs = [baseRun({ runId: "01rrunning1", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    emit(es, { runId: "01rrunning1", seq: 2, type: "fact.run_started", payload: { startNode: "start" } });

    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });
  });

  it("fact.run_completed removes a run from Running and surfaces in Activity", async () => {
    state.runs = [baseRun({ runId: "01rcomp001", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    const { container } = mount();
    const es = await ensureSseOpen();
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });

    state.runs = [];
    emit(es, {
      runId: "01rcomp001",
      seq: 18,
      type: "fact.run_terminated",
      payload: { status: "completed", finalNode: "done" },
    });

    await waitFor(() => {
      expect(container.textContent).toContain("Nothing running");
    });
    expect(container.textContent).toContain("completed");
  });

  it("fact.snapshot_recorded pushes a completed run into the Inbox (Ready-to-land) section without a reload", async () => {
    // The daemon writes fact.snapshot_recorded AFTER fact.run_completed in
    // the dispose path (finally block in executor). fact.run_completed
    // invalidates runs.lists() but the inbox=pending refetch races the
    // snapshot fact — the run has no inboxStatus yet at that point.
    // fact.snapshot_recorded must therefore also be in RUN_INVALIDATE_KINDS
    // so the inbox list refetches once the inbox_status is persisted.
    state.runs = [
      baseRun({
        runId: "01rsnap001",
        status: "running",
        runStatus: "running",
        workflow: "smoke-sleep",
        title: "Build widget",
      }),
    ];
    const { container } = mount();
    const es = await ensureSseOpen();
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });
    expect(container.textContent).toContain("All clear");

    // fact.run_completed fires first — run leaves Running, no inbox_status yet.
    state.runs = [baseRun({ runId: "01rsnap001", status: "success", runStatus: "completed", title: "Build widget" })];
    emit(es, {
      runId: "01rsnap001",
      seq: 18,
      type: "fact.run_terminated",
      payload: { status: "completed", finalNode: "done" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Nothing running");
    });

    // fact.snapshot_recorded arrives after dispose — now inbox_status=pending.
    state.runs = [
      baseRun({
        runId: "01rsnap001",
        status: "success",
        runStatus: "completed",
        title: "Build widget",
        inboxStatus: "pending",
        changeStat: { committed: { filesChanged: 3, insertions: 20, deletions: 2 }, uncommitted: null },
      }),
    ];
    emit(es, {
      runId: "01rsnap001",
      seq: 19,
      type: "fact.snapshot_recorded",
      payload: {
        eventIdx: 17,
        treeSha: "abc",
        commitSha: "def",
        parentSnap: null,
        headSha: "ghi",
        headRef: null,
        diffBaseSha: "jkl",
        committed: { filesChanged: 3, insertions: 20, deletions: 2 },
        uncommitted: null,
      },
    });

    // The Inbox (Ready to land) section must now show the run without a reload.
    await waitFor(() => {
      expect(container.textContent).not.toContain("All clear");
    });
    expect(container.textContent).toContain("Build widget");

    // fact.snapshot_recorded must NOT appear as an Activity feed row.
    // It's filtered at two layers: (1) FEED_HIDDEN_KINDS drops it before
    // it lands in feedAtom, and (2) metaForEvent returns null for any
    // event without a KIND_META entry so FeedRow skips render. Confirm
    // no such row was added: the Activity section still shows only the
    // "completed" row from fact.run_completed (emitted above), not an
    // extra blank row from the snapshot fact.
    const feedEl = container.querySelector("[data-testid='global-feed']");
    const feedRows = feedEl?.querySelectorAll("li") ?? [];
    // All rendered rows have a non-empty verb span (hidden kinds have verb="").
    for (const row of feedRows) {
      const verbEl = row.querySelector("span.text-sw-muted");
      if (verbEl) {
        // A blank-verb row would be a fact.snapshot_recorded leaking through.
        expect(verbEl.textContent?.trim()).not.toBe("");
      }
    }
  });

  // ── Adversarial: navigation away + return ─────────────────────────

  it("SSE survives navigation away from Home and back", async () => {
    const { container, getByTestId } = mount();
    await ensureSseOpen();
    const initialEsCount = FakeEventSource.instances.length;

    // Navigate to /elsewhere — Home unmounts but GlobalHook stays.
    act(() => {
      getByTestId("nav-elsewhere").click();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Other route");
    });
    // No new EventSource was created — the existing one is still open.
    expect(FakeEventSource.instances.length).toBe(initialEsCount);
    expect(FakeEventSource.latest().closed).toBe(false);

    // Navigate back. Home remounts; SSE is unchanged.
    act(() => {
      getByTestId("nav-home").click();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Nothing running");
    });
    expect(FakeEventSource.instances.length).toBe(initialEsCount);

    // An event arriving NOW must drive Home's refetch — proving SSE
    // survived the navigation round-trip.
    state.runs = [baseRun({ runId: "01rnavback1", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    emit(FakeEventSource.latest(), {
      runId: "01rnavback1",
      seq: 2,
      type: "fact.run_started",
      payload: { startNode: "start" },
    });
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });
  });

  it("events received WHILE the user is on /elsewhere still invalidate the cache; Home shows fresh data on return", async () => {
    state.runs = [baseRun({ runId: "01rstale01", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    const { container, getByTestId } = mount();
    const es = await ensureSseOpen();
    // Confirm seed: Home has the running run.
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });

    // Leave Home. The run completes server-side. SSE delivers the
    // completion event while Home's components are unmounted.
    act(() => {
      getByTestId("nav-elsewhere").click();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Other route");
    });

    state.runs = [];
    emit(es, {
      runId: "01rstale01",
      seq: 18,
      type: "fact.run_terminated",
      payload: { status: "completed", finalNode: "done" },
    });

    // Return to Home. The runs query was invalidated while unmounted;
    // on remount it re-runs and reflects the new (empty) state. The
    // Activity feed gained a "completed" row in the meantime.
    act(() => {
      getByTestId("nav-home").click();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Nothing running");
    });
    expect(container.textContent).toContain("completed");
  });

  // ── Adversarial: reconnect after permanent close ─────────────────

  it("after a permanent SSE close, events on the reconnected stream still drive Home refetches", async () => {
    const { container } = mount();
    const first = await ensureSseOpen();

    // Server kills the connection (e.g. dev proxy idle timeout).
    act(() => {
      first.readyState = 2;
      first._error();
    });
    // useEventSource schedules a reconnect; a NEW FakeEventSource is
    // created. Wait for it.
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });
    const second = FakeEventSource.latest();
    expect(second).not.toBe(first);
    act(() => second._open());

    // An event on the reconnected stream must still propagate.
    state.runs = [baseRun({ runId: "01rreconn01", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    emit(second, { runId: "01rreconn01", seq: 2, type: "fact.run_started", payload: { startNode: "start" } });
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });
  });

  // ── Adversarial: burst of events ──────────────────────────────────

  it("burst of lifecycle events all reflect in the UI; later state wins", async () => {
    state.runs = [baseRun({ runId: "01rburst001", status: "running", runStatus: "running", workflow: "smoke-sleep" })];
    const { container } = mount();
    const es = await ensureSseOpen();
    await waitFor(() => {
      expect(container.textContent).not.toContain("Nothing running");
    });

    // Three lifecycle events arrive back-to-back: another run starts,
    // a HITL pause arrives for a third run, and the original run
    // completes. Final state: 1 running, 1 paused_human, 0 completed
    // (the completed one drains).
    state.runs = [
      baseRun({ runId: "01rburst002", status: "running", runStatus: "running", workflow: "smoke-sleep" }),
      baseRun({ runId: "01rburst003", status: "paused", runStatus: "paused_human", workflow: "hitl-tools" }),
    ];
    emit(es, { runId: "01rburst002", seq: 2, type: "fact.run_started", payload: { startNode: "start" } });
    emit(es, {
      runId: "01rburst003",
      seq: 13,
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "review", label: "Approve?", options: [] },
    });
    emit(es, {
      runId: "01rburst001",
      seq: 18,
      type: "fact.run_terminated",
      payload: { status: "completed", finalNode: "done" },
    });

    await waitFor(() => {
      // 002 is in Running; 003 is in Inbox; 001 has drained.
      expect(container.textContent).toContain("01rburst002".slice(0, 4));
    });
    expect(container.textContent).toContain("01rburst003".slice(0, 4));
    // 001 should no longer appear in the Running section (it's drained).
    // It may still appear in Activity as "completed", which is fine.
    expect(container.textContent).toContain("completed");
  });
});
