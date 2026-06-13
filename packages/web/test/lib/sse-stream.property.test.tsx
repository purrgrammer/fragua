// Property tests for the SSE consumption hooks.
//
// The example-based suites (useEventSource / useRunLive /
// useGlobalEventStream) drive a handful of hand-written frame sequences.
// The branchy reconnect / gap-replay / dedup logic is exactly what
// generative testing catches and a fixed sequence misses, so these
// properties exercise the invariants under arbitrary orderings and an
// arbitrary reconnect:
//
//   1. Cursor monotonicity — the cost-frame accumulator only advances:
//      a frame whose seq is ≤ the last captured seq is never counted, so
//      the consumer never regresses its cursor and never folds an event
//      twice. Holds for any ordering of (possibly duplicate, possibly
//      out-of-order) seqs.
//   2. Gap-replay de-duplication — after a real EventSource reconnect,
//      replaying an overlapping seq window plus a fresh tail yields each
//      event to the consumer exactly once (the overlap is dropped, the
//      tail is folded). The dedup cursor lives in React state, not on the
//      socket, so it survives the reconnect.
//   3. Cache-invalidation terminal consistency — under an arbitrary
//      interleaving of run-lifecycle frames across several runs, the
//      react-query cache is invalidated once per frame for the run it
//      names, so a terminal frame always lands and the cache can't be
//      left stale-after-terminal.

import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { queries } from "../../src/lib/queries.ts";
import { __invalidateKinds, useGlobalEventStream } from "../../src/lib/useGlobalEventStream.ts";
import { useRunLive } from "../../src/lib/useRunLive.ts";
import { createTestQueryClient, installFetchMock, json } from "../helpers/with-query-client.tsx";

// Minimal fake EventSource — same shape used across the web suite. The
// hook drives lifecycle synchronously through `_open` / `_emit`, with no
// real network and no real timers.
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
  _emit(data: string, id?: string): void {
    const ev = new MessageEvent("message", { data, lastEventId: id ?? "" });
    for (const l of this.listeners.get("message") ?? []) l(ev as unknown as Event);
  }
  _error(): void {
    for (const l of this.listeners.get("error") ?? []) l(new Event("error"));
  }
}

const ES = FakeEventSource as unknown as typeof EventSource;

/** The subsequence the cost accumulator keeps: a frame is captured iff
 * its seq strictly exceeds the running max of every seq captured so far.
 * This is the exact semantics of the hook's `if (idNum <= last) return
 * prev` dedup guard, expressed independently so the property compares the
 * hook's output against a model, not against itself. */
function runningMaxKept(seqs: readonly number[]): number[] {
  let max = Number.NEGATIVE_INFINITY;
  const kept: number[] = [];
  for (const s of seqs) {
    if (s > max) {
      kept.push(s);
      max = s;
    }
  }
  return kept;
}

function costFrame(seq: number): string {
  // cost_usd 1 per frame so the folded total counts captured frames;
  // input_tokens = seq so the folded sum pins *which* frames were kept.
  return JSON.stringify({ type: "cost.recorded", payload: { cost_usd: 1, input_tokens: seq } });
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
});

describe("SSE cost-frame cursor — monotonicity & exactly-once", () => {
  it("never folds a frame whose seq ≤ the last captured, under any ordering of (dup, out-of-order) seqs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 60 }), { maxLength: 40 }), async (seqs) => {
        const mock = installFetchMock({}, ({ url }) => (url.includes("/messages") ? json([]) : json([])));
        try {
          FakeEventSource.instances = [];
          const { result } = renderHook(() => useRunLive("r1", { terminal: false, sinceSeq: 0, eventSourceImpl: ES }));
          await waitFor(() => {
            expect(FakeEventSource.instances.length).toBe(1);
          });
          const es = FakeEventSource.instances[0]!;
          act(() => es._open());

          act(() => {
            for (const s of seqs) es._emit(costFrame(s), String(s));
          });
          await waitFor(() => {
            expect(result.current.totalEvents).toBe(seqs.length);
          });

          const kept = runningMaxKept(seqs);
          // totalCostUsd counts captured frames; totalInputTokens sums
          // their seqs. Both matching the running-max model proves the
          // cursor never regressed and no frame was double-folded.
          expect(result.current.liveCost.totalCostUsd).toBe(kept.length);
          expect(result.current.liveCost.totalInputTokens).toBe(kept.reduce((a, b) => a + b, 0));
        } finally {
          mock.restore();
          cleanup();
          FakeEventSource.instances = [];
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("SSE gap-replay — dedup across a real reconnect", () => {
  it("replaying an overlapping seq window after a reconnect folds each event exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          base: fc.uniqueArray(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 12 }),
          overlap: fc.nat({ max: 12 }),
          tailLen: fc.integer({ min: 0, max: 5 }),
        }),
        async ({ base: baseRaw, overlap, tailLen }) => {
          const base = [...baseRaw].sort((a, b) => a - b);
          const overlapWindow = base.slice(Math.max(0, base.length - overlap));
          const maxBase = base[base.length - 1]!;
          const tail = Array.from({ length: tailLen }, (_, i) => maxBase + i + 1);

          const mock = installFetchMock({}, ({ url }) => (url.includes("/messages") ? json([]) : json([])));
          try {
            FakeEventSource.instances = [];
            const { result } = renderHook(() =>
              useRunLive("r1", { terminal: false, sinceSeq: 0, eventSourceImpl: ES }),
            );
            await waitFor(() => {
              expect(FakeEventSource.instances.length).toBe(1);
            });
            const first = FakeEventSource.instances[0]!;
            act(() => first._open());

            // Connection #1: deliver the base stream in seq order.
            act(() => {
              for (const s of base) first._emit(costFrame(s), String(s));
            });

            // Permanent close → the hook schedules its own reconnect.
            act(() => {
              first.readyState = 2;
              first._error();
            });
            await waitFor(() => {
              expect(FakeEventSource.instances.length).toBe(2);
            });
            const second = FakeEventSource.instances[1]!;
            act(() => second._open());

            // Connection #2: replay the overlap window (already folded),
            // then the fresh tail. Overlap must be dropped; tail folded.
            act(() => {
              for (const s of overlapWindow) second._emit(costFrame(s), String(s));
              for (const s of tail) second._emit(costFrame(s), String(s));
            });

            const expectedCount = base.length + tail.length;
            const expectedSum = [...base, ...tail].reduce((a, b) => a + b, 0);
            await waitFor(() => {
              expect(result.current.liveCost.totalCostUsd).toBe(expectedCount);
            });
            expect(result.current.liveCost.totalInputTokens).toBe(expectedSum);
          } finally {
            mock.restore();
            cleanup();
            FakeEventSource.instances = [];
          }
        },
      ),
      { numRuns: 12 },
    );
  }, 30_000);
});

describe("SSE cache-invalidation — terminal consistency", () => {
  it("invalidates the runs cache once per lifecycle frame for the run it names, under any interleaving", async () => {
    const kinds = [...__invalidateKinds];
    const runIds = ["run-a", "run-b", "run-c"];

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            runId: fc.constantFrom(...runIds),
            type: fc.constantFrom(...kinds),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        async (frames) => {
          const client = createTestQueryClient();
          const invalidatedKeys: ReadonlyArray<unknown>[] = [];
          client.invalidateQueries = ((filters?: { queryKey?: ReadonlyArray<unknown> }) => {
            if (filters?.queryKey) invalidatedKeys.push(filters.queryKey);
            return Promise.resolve();
          }) as typeof client.invalidateQueries;

          const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          );

          const mock = installFetchMock({}, ({ url }) => (/\/api\/events/.test(url) ? json([]) : json([])));
          try {
            FakeEventSource.instances = [];
            renderHook(() => useGlobalEventStream({ eventSourceImpl: ES, reconnectBaseMs: 5, stallMs: 10_000 }), {
              wrapper,
            });
            await waitFor(() => {
              expect(FakeEventSource.instances.length).toBe(1);
            });
            const es = FakeEventSource.instances[0]!;
            act(() => es._open());

            act(() => {
              let seq = 1;
              for (const f of frames) {
                es._emit(JSON.stringify({ type: f.type, runId: f.runId, seq: seq++, ts: Date.now() }));
              }
            });

            // Every lifecycle frame invalidates the shared lists key once,
            // so the total lists-invalidation count converges to the frame
            // count — no frame is dropped on the way to the cache.
            const listsKey = JSON.stringify(queries.runs.lists());
            const listsCount = invalidatedKeys.filter((k) => JSON.stringify(k) === listsKey).length;
            expect(listsCount).toBe(frames.length);

            // And the detail key for each run is invalidated exactly as
            // many times as that run had frames — so the terminal frame
            // for any run always reaches its detail query (no
            // stale-after-terminal), regardless of interleaving.
            for (const runId of runIds) {
              const expected = frames.filter((f) => f.runId === runId).length;
              const detailKey = JSON.stringify(queries.runs.detail(runId).queryKey);
              const got = invalidatedKeys.filter((k) => JSON.stringify(k) === detailKey).length;
              expect(got).toBe(expected);
            }
          } finally {
            mock.restore();
            cleanup();
            client.clear();
            FakeEventSource.instances = [];
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
