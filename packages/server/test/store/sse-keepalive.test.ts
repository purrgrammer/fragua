// Keepalive coverage for the shared SSE drain-emit-sleep loop.
//
// Without keepalive two things break:
//   1. Intermediate proxies (Vite's http-proxy in dev, load balancers
//      in prod) kill connections that go quiet for >10–15s — operators
//      see "Running stuck" because `fact.run_completed` (15+s after
//      `fact.run_started`) never reaches the client.
//   2. A half-open TCP socket (laptop sleep, NAT rebind, wifi handoff)
//      can leave the browser's EventSource in `OPEN` for many minutes
//      with zero traffic — onmessage doesn't fire, so the client-side
//      stall watchdog can't notice.
//
// Both are addressed by emitting a real `data: {"type":"fragua.ping"}`
// SSE frame on idle. Bytes-on-wire reset the proxy timer; the `data:`
// shape (vs `:` comment) fires `onmessage` so the watchdog re-arms.
// These tests pin that wire shape.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@fragua/store";
import type { SSEStreamingApi } from "hono/streaming";
import { runSseLoop } from "../../src/store/sse.ts";

interface FakeStreamFrame {
  kind: "sse" | "raw";
  text: string;
}

/** Minimal fake of hono's SSEStreamingApi. Captures every wire frame
 *  the loop produces; tests assert on `frames` and toggle `aborted`
 *  to terminate the loop. */
function makeFakeStream(): {
  api: SSEStreamingApi;
  frames: FakeStreamFrame[];
  abort(): void;
  /** Sleep stubs out hono's stream.sleep so the loop runs to completion
   *  in synchronous test time. Each call advances the fake clock by
   *  `pollMs`. */
  setClock(advance: (ms: number) => void): void;
} {
  const frames: FakeStreamFrame[] = [];
  let aborted = false;
  let onSleep: ((ms: number) => void) | undefined;
  const api: Partial<SSEStreamingApi> = {
    get aborted() {
      return aborted;
    },
    async writeSSE({ data, id }: { data: string | Promise<string>; id?: string }): Promise<void> {
      frames.push({ kind: "sse", text: `id:${id ?? ""}|${typeof data === "string" ? data : await data}` });
    },
    async write(text: Uint8Array | string): Promise<SSEStreamingApi> {
      frames.push({ kind: "raw", text: typeof text === "string" ? text : new TextDecoder().decode(text) });
      return api as SSEStreamingApi;
    },
    async sleep(ms: number): Promise<void> {
      onSleep?.(ms);
      // Yield once so any pending microtasks (and the abort flag) settle.
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

function ev(seq: number, ts: number): StoredEvent {
  return { runId: "r1", seq, ts, type: "fact.run_started", writer: "daemon", payload: {} };
}

/** Ping frames are emitted via `writeSSE`, so they show up as `kind:"sse"`
 * in the fake stream's frame log. They're disambiguated from real events
 * by the lack of an `id:` field and a payload of `{"type":"fragua.ping",…}`. */
function isPingFrame(f: FakeStreamFrame): boolean {
  return f.kind === "sse" && f.text.startsWith("id:|") && /"type":"fragua\.ping"/.test(f.text);
}

describe("runSseLoop keepalive", () => {
  test("emits a fragua.ping data frame after keepaliveMs of silence", async () => {
    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    setClock((ms) => {
      now += ms;
      // After 25s of silence (well past the 10s keepalive window) abort.
      if (now > 1_000_000 + 25_000) abort();
    });

    await runSseLoop<number>(api, 0, {
      fetchBatch: () => [], // never any events — pure idle
      cursorOf: () => 0,
      idOf: () => "0",
      batchSize: 100,
      pollMs: 100,
      keepaliveMs: 10_000,
      now: () => now,
    });

    const pings = frames.filter(isPingFrame);
    // 25s of silence with a 10s keepalive should produce 2 pings (at
    // ~10s and ~20s). Assert at-least-2 so minor poll-cadence drift
    // doesn't flake the test.
    expect(pings.length).toBeGreaterThanOrEqual(2);
    // The ping carries a server-side `ts` so the client can log it; we
    // only pin the envelope (lacks runId/seq, has the type sentinel) so
    // future `ts` shape changes don't break this test.
    expect(pings[0]?.text).toMatch(/"type":"fragua\.ping","ts":\d+/);
    expect(pings[0]?.text).not.toMatch(/"runId"|"seq"/);
    // No real (non-ping) events emitted.
    expect(frames.filter((f) => f.kind === "sse" && !isPingFrame(f))).toHaveLength(0);
  });

  test("emitting an event resets the keepalive window", async () => {
    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    let emittedOnce = false;
    setClock((ms) => {
      now += ms;
      if (now > 1_000_000 + 12_000) abort();
    });

    await runSseLoop<number>(api, 0, {
      fetchBatch: () => {
        // Emit one event at t≈5s, then go silent.
        if (!emittedOnce && now >= 1_000_000 + 5_000) {
          emittedOnce = true;
          return [ev(1, now)];
        }
        return [];
      },
      cursorOf: (e) => e.seq,
      idOf: (e) => String(e.seq),
      batchSize: 100,
      pollMs: 100,
      keepaliveMs: 10_000,
      now: () => now,
    });

    const realFrames = frames.filter((f) => f.kind === "sse" && !isPingFrame(f));
    const pings = frames.filter(isPingFrame);
    // One real event was emitted.
    expect(realFrames).toHaveLength(1);
    // Total elapsed: 12s. Event at 5s reset the timer. Next keepalive
    // would fire at 15s — past the abort. So 0 pings expected.
    expect(pings).toHaveLength(0);
  });

  test("never emits a keepalive when events are flowing continuously", async () => {
    const { api, frames, abort, setClock } = makeFakeStream();
    let now = 1_000_000;
    let nextSeq = 1;
    setClock((ms) => {
      now += ms;
      if (now > 1_000_000 + 30_000) abort();
    });

    await runSseLoop<number>(api, 0, {
      fetchBatch: () => {
        // Always emit one event per poll — no idle window opens.
        return [ev(nextSeq++, now)];
      },
      cursorOf: (e) => e.seq,
      idOf: (e) => String(e.seq),
      batchSize: 100,
      pollMs: 100,
      keepaliveMs: 10_000,
      now: () => now,
    });

    const pings = frames.filter(isPingFrame);
    expect(pings).toHaveLength(0);
    // Many real (non-ping) events flowed.
    expect(frames.filter((f) => f.kind === "sse" && !isPingFrame(f)).length).toBeGreaterThan(10);
  });

  test("respects shouldClose() before sending a keepalive", async () => {
    // shouldClose fires AFTER a non-full batch; the loop must return
    // before the keepalive logic gets a chance to write.
    const { api, frames } = makeFakeStream();
    await runSseLoop<number>(api, 0, {
      fetchBatch: () => [],
      cursorOf: () => 0,
      idOf: () => "0",
      shouldClose: () => true,
      batchSize: 100,
      pollMs: 100,
      keepaliveMs: 10_000,
      now: () => 0,
    });
    expect(frames).toHaveLength(0);
  });
});
