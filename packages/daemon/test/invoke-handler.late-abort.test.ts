// Late-abort delivery — the sleep-collapse contract.
//
// The leak sentinel is one absolute timer anchored at dispatch
// (`setTimeout(watchdogMaxMs + leakGraceMs)`), and the maxMs abort is a
// separate absolute timer. System sleep freezes both; the wake flushes them
// in the same event-loop tick, so a handler that honors its signal — but
// needs a moment to tear down (the llm backend's ABORT_TEARDOWN_GRACE_MS) —
// loses the race to the sentinel and is declared leaked. That collapse is
// exactly what halted three runs on 2026-06-11 (leakedAt 04:51:45, abort and
// sentinel due hours earlier, both flushed on wake).
//
// Contract under test: the leak grace is the time a handler gets AFTER the
// abort is delivered. A handler that settles within `leakGraceMs` of actual
// abort delivery is never a leak — no matter how late the abort itself
// arrived relative to dispatch.

import { describe, expect, test } from "bun:test";
import type * as core from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { invokeHandler } from "../src/invoke-handler.ts";

const MAX_MS = 50;
const LEAK_GRACE_MS = 100;
const SENTINEL_DUE_MS = MAX_MS + LEAK_GRACE_MS;
/** Handler teardown latency after the abort lands — models the backend's
 * 2s ABORT_TEARDOWN_GRACE_MS, scaled down. Well inside LEAK_GRACE_MS. */
const TEARDOWN_MS = 20;

/** A signal-honoring handler with a realistic teardown: rejects with the
 * signal's reason TEARDOWN_MS after the abort is delivered. */
function honoringHandler(signal: AbortSignal): core.HandlerSpec["handler"] {
  return () =>
    new Promise<core.HandlerResult>((_, reject) => {
      const bail = (): void => {
        setTimeout(() => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, TEARDOWN_MS);
      };
      if (signal.aborted) {
        bail();
        return;
      }
      signal.addEventListener("abort", bail, { once: true });
    });
}

describe("invokeHandler — late abort delivery (sleep-collapsed timers)", () => {
  test("a handler that honors an abort delivered AT the sentinel deadline is not a leak", async () => {
    const steerCtrl = new AbortController();
    // The maxMs abort timer, frozen by sleep and flushed at the sentinel's
    // own deadline: fire it manually at SENTINEL_DUE_MS instead of MAX_MS.
    const lateAbort = new AbortController();
    const signal = AbortSignal.any([steerCtrl.signal, lateAbort.signal]);
    const fireLate = setTimeout(() => {
      const err = new Error(`dispatch deadline exceeded (${MAX_MS}ms)`);
      err.name = "TimeoutError";
      lateAbort.abort(err);
    }, SENTINEL_DUE_MS);

    try {
      const out = await invokeHandler({
        spec: {
          kind: "step",
          sideEffect: "none",
          maxMs: MAX_MS,
          handler: honoringHandler(signal),
        } as core.HandlerSpec,
        ctx: { signal } as core.HandlerContext,
        registry: new AbortRegistry(),
        runId: "r",
        steerCtrl,
        leakGraceMs: LEAK_GRACE_MS,
      });

      // The handler settled TEARDOWN_MS (20ms) after the abort landed —
      // far inside the 100ms grace. Declaring it leaked means the grace was
      // measured from dispatch, not from abort delivery.
      expect(out.kind).not.toBe("leak");
      expect(out).toMatchObject({ kind: "thrown", abortByName: true });
    } finally {
      clearTimeout(fireLate);
    }
  }, 10_000);

  test("control: the same handler with on-time abort delivery is not a leak", async () => {
    const steerCtrl = new AbortController();
    const signals: AbortSignal[] = [steerCtrl.signal, AbortSignal.timeout(MAX_MS)];
    const signal = AbortSignal.any(signals);
    const out = await invokeHandler({
      spec: {
        kind: "step",
        sideEffect: "none",
        maxMs: MAX_MS,
        handler: honoringHandler(signal),
      } as core.HandlerSpec,
      ctx: { signal } as core.HandlerContext,
      registry: new AbortRegistry(),
      runId: "r",
      steerCtrl,
      leakGraceMs: LEAK_GRACE_MS,
    });
    expect(out).toMatchObject({ kind: "thrown", abortByName: true });
  }, 10_000);
});
