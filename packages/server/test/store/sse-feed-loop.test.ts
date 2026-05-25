// Coverage for the global-feed `runGlobalFeedLoop` and its
// `parseGlobalCursorFromHeader` companion.
//
// The two-cursor design (`maxAt` for forward, `minAt` for look-back)
// has two load-bearing properties pinned here:
//   1. Forward strict-tuple advances on every emission so a same-ts
//      batch larger than `LIMIT N` paginates across iterations
//      without re-fetching the same N rows.
//   2. Look-back catches new INSERTs at the boundary `ts` whose
//      `run_id` lex-sorts before the current `minAt` — strict-tuple
//      forward alone would never see them.

import { describe, expect, test } from "bun:test";
import type { GetGlobalEventsAtFloorOpts, GetGlobalEventsForwardOpts, StoredEvent } from "@fragua/store";
import type { SSEStreamingApi } from "hono/streaming";
import { parseGlobalCursorFromHeader, runGlobalFeedLoop } from "../../src/store/sse.ts";

interface FakeFrame {
  kind: "sse" | "raw";
  text: string;
}

function makeFakeStream(): {
  api: SSEStreamingApi;
  frames: FakeFrame[];
  abort(): void;
  setClock(advance: (ms: number) => void): void;
} {
  const frames: FakeFrame[] = [];
  let aborted = false;
  let onSleep: ((ms: number) => void) | undefined;
  const api: Partial<SSEStreamingApi> = {
    get aborted() {
      return aborted;
    },
    async writeSSE({ data, id }: { data: string | Promise<string>; id?: string }): Promise<void> {
      const text = typeof data === "string" ? data : await data;
      frames.push({ kind: "sse", text: `id:${id ?? ""}|${text}` });
    },
    async write(text: Uint8Array | string): Promise<SSEStreamingApi> {
      frames.push({ kind: "raw", text: typeof text === "string" ? text : new TextDecoder().decode(text) });
      return api as SSEStreamingApi;
    },
    async sleep(ms: number): Promise<void> {
      onSleep?.(ms);
      // Yield once so the abort flag picks up before the next iteration.
      await Promise.resolve();
    },
  };
  return {
    api: api as SSEStreamingApi,
    frames,
    abort: () => {
      aborted = true;
    },
    setClock: (advance) => {
      onSleep = advance;
    },
  };
}

function ev(runId: string, seq: number, ts: number, type = "fact.run_started"): StoredEvent {
  return { runId, seq, ts, type, writer: "daemon", payload: {} };
}

function isPing(f: FakeFrame): boolean {
  return f.kind === "sse" && f.text.startsWith("id:|") && /"type":"fragua\.ping"/.test(f.text);
}

function realFrames(frames: FakeFrame[]): FakeFrame[] {
  return frames.filter((f) => f.kind === "sse" && !isPing(f));
}

function idsOf(frames: FakeFrame[]): string[] {
  return realFrames(frames).map((f) => {
    const match = /^id:(.+?)\|/.exec(f.text);
    return match ? match[1]! : "";
  });
}

describe("runGlobalFeedLoop", () => {
  test("drains a full-batch-at-same-ts without stalling", async () => {
    // Seed N events at the same `ts`. `LIMIT batchSize` clips each
    // batch; the forward strict-tuple cursor advances on every emit so
    // pagination walks through them across iterations until drained.
    const ts = 5_000_000;
    const total = 8;
    const batchSize = 3;
    const all: StoredEvent[] = Array.from({ length: total }, (_, i) => ev(`r${String(i).padStart(2, "0")}`, 1, ts));

    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    setClock((ms) => {
      now += ms;
    });

    const fetchForward = (opts: GetGlobalEventsForwardOpts): StoredEvent[] => {
      const filtered = all.filter((e) => {
        if (e.ts > opts.floorTs) return true;
        if (e.ts < opts.floorTs) return false;
        if (e.runId > opts.lastRunId) return true;
        if (e.runId < opts.lastRunId) return false;
        return e.seq > opts.lastSeq;
      });
      const sorted = filtered.sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq);
      const out = sorted.slice(0, opts.limit);
      // Once the full set is delivered, abort so the loop terminates.
      if (out.length === 0) abort();
      return out;
    };

    await runGlobalFeedLoop(
      api,
      { floorTs: ts, maxAt: null },
      {
        fetchForward,
        fetchAtFloor: () => [],
        batchSize,
        pollMs: 1,
        keepaliveMs: 999_999,
        now: () => now,
      },
    );

    expect(idsOf(frames)).toEqual(all.map((e) => `${e.ts}.${e.runId}.${e.seq}`));
  });

  test("rescan delivers a same-ts new INSERT regardless of where it lex-falls vs the cursor", async () => {
    // Forward emits (T, "z", 1); two new events then INSERT at the
    // same ts: one lex-smaller (T, "a", 1) and one lex-between two
    // already-emitted runs (T, "m", 5) — neither is `> maxAt = (z, 1)`
    // for the forward query. The boundary rescan walks every event at
    // floorTs and the Set filters duplicates.
    const ts = 6_000_000;
    const all: StoredEvent[] = [ev("z", 1, ts)];
    let forwardCalls = 0;

    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    setClock((ms) => {
      now += ms;
    });

    const fetchForward = (opts: GetGlobalEventsForwardOpts): StoredEvent[] => {
      forwardCalls++;
      // After the first forward returns "z", inject the stragglers.
      if (forwardCalls === 2 && all.length === 1) {
        all.push(ev("a", 1, ts));
        all.push(ev("m", 5, ts));
      }
      const matched = all.filter((e) => {
        if (e.ts > opts.floorTs) return true;
        if (e.ts < opts.floorTs) return false;
        if (e.runId > opts.lastRunId) return true;
        if (e.runId < opts.lastRunId) return false;
        return e.seq > opts.lastSeq;
      });
      if (forwardCalls >= 3) abort();
      return matched.sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq).slice(0, opts.limit);
    };

    const fetchAtFloor = (opts: GetGlobalEventsAtFloorOpts): StoredEvent[] => {
      const matched = all.filter((e) => {
        if (e.ts !== opts.floorTs) return false;
        if (e.runId > opts.afterRunId) return true;
        if (e.runId < opts.afterRunId) return false;
        return e.seq > opts.afterSeq;
      });
      return matched.sort((a, b) => a.runId.localeCompare(b.runId) || a.seq - b.seq).slice(0, opts.limit);
    };

    await runGlobalFeedLoop(
      api,
      { floorTs: ts, maxAt: null },
      {
        fetchForward,
        fetchAtFloor,
        batchSize: 100,
        pollMs: 1,
        keepaliveMs: 999_999,
        now: () => now,
      },
    );

    const ids = idsOf(frames);
    expect(ids).toContain(`${ts}.z.1`);
    expect(ids).toContain(`${ts}.a.1`);
    expect(ids).toContain(`${ts}.m.5`);
  });

  test("aborts mid-drain between writeSSE calls (no full-batch processing on disconnect)", async () => {
    // Seed a 5-element batch but flip `aborted` after the second
    // writeSSE — the loop must bail rather than processing all five.
    const ts = 7_000_000;
    const all: StoredEvent[] = Array.from({ length: 5 }, (_, i) => ev(`r${i}`, 1, ts));

    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    setClock((ms) => {
      now += ms;
    });

    let writeCount = 0;
    const wrappedApi: SSEStreamingApi = {
      ...(api as SSEStreamingApi),
      get aborted() {
        return (api as { aborted: boolean }).aborted;
      },
      async writeSSE(args: Parameters<SSEStreamingApi["writeSSE"]>[0]): Promise<void> {
        writeCount++;
        await api.writeSSE!(args);
        if (writeCount === 2) abort();
      },
      sleep: api.sleep!,
      write: api.write!,
    } as SSEStreamingApi;

    let forwardCalls = 0;
    const fetchForward = (): StoredEvent[] => {
      forwardCalls++;
      // First call: return the full batch. After that, return nothing
      // (the loop should already be aborted).
      return forwardCalls === 1 ? all : [];
    };

    await runGlobalFeedLoop(
      wrappedApi,
      { floorTs: ts, maxAt: null },
      {
        fetchForward,
        fetchAtFloor: () => [],
        batchSize: 5,
        pollMs: 1,
        keepaliveMs: 999_999,
        now: () => now,
      },
    );

    // Only the first two events made it to the wire before the abort.
    expect(realFrames(frames)).toHaveLength(2);
  });
});

describe("parseGlobalCursorFromHeader", () => {
  test("no header, no fromTs → cursor at origin with unset maxAt", () => {
    const c = parseGlobalCursorFromHeader({ fromTs: undefined, lastEventId: undefined });
    expect(c).toEqual({ floorTs: 0, maxAt: null });
  });

  test("?fromTs alone → floorTs from query, cursor unset (first connect)", () => {
    const c = parseGlobalCursorFromHeader({ fromTs: "1234", lastEventId: undefined });
    expect(c).toEqual({ floorTs: 1234, maxAt: null });
  });

  test("Last-Event-ID alone → full triple seeds maxAt", () => {
    const c = parseGlobalCursorFromHeader({ fromTs: undefined, lastEventId: "5000.r1.42" });
    expect(c).toEqual({
      floorTs: 5000,
      maxAt: { runId: "r1", seq: 42 },
    });
  });

  test("header dominates when at least as fresh as ?fromTs (typical reconnect)", () => {
    const c = parseGlobalCursorFromHeader({ fromTs: "100", lastEventId: "5000.r1.42" });
    expect(c.floorTs).toBe(5000);
    expect(c.maxAt).toEqual({ runId: "r1", seq: 42 });
  });

  test("?fromTs dominates when fresher than the header (atypical, defensive)", () => {
    // E.g., the page was reloaded with a fresh ?fromTs but the browser
    // still attached an older Last-Event-ID from a stale session.
    const c = parseGlobalCursorFromHeader({ fromTs: "9000", lastEventId: "5000.r1.42" });
    expect(c.floorTs).toBe(9000);
    expect(c.maxAt).toBeNull();
  });

  test("malformed header is ignored", () => {
    const c = parseGlobalCursorFromHeader({ fromTs: "1234", lastEventId: "garbage" });
    expect(c).toEqual({ floorTs: 1234, maxAt: null });
  });

  test("negative or NaN ?fromTs clamps to 0", () => {
    const c1 = parseGlobalCursorFromHeader({ fromTs: "-1", lastEventId: undefined });
    expect(c1.floorTs).toBe(0);
    const c2 = parseGlobalCursorFromHeader({ fromTs: "abc", lastEventId: undefined });
    expect(c2.floorTs).toBe(0);
  });
});
