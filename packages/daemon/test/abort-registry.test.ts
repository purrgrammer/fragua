// AbortRegistry — per-process bookkeeping for in-flight handler
// controllers. These tests lock the pause-aware contract: elapsed time
// is measured from `register()` to now using a supplied clock, so a
// test clock that never advances proves a paused process accrues no
// elapsed time.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { AbortRegistry } from "../src/abort-registry.ts";

function fakeClock(initial = 0): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

describe("AbortRegistry — basics", () => {
  test("register → trip aborts the controller", () => {
    const reg = new AbortRegistry();
    const ctrl = new AbortController();
    reg.register("r1", ctrl);
    expect(reg.trip("r1")).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("concurrent registers coexist (fan-out branches); each disposer removes only its own entry", () => {
    const reg = new AbortRegistry();
    const c1 = new AbortController();
    const c2 = new AbortController();
    const dispose1 = reg.register("r1", c1);
    const dispose2 = reg.register("r1", c2);
    expect(reg.has("r1")).toBe(true);
    // trip aborts the whole set (cancel/shutdown ends the superstep).
    reg.trip("r1");
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    // Disposing one leaves the run live until the last disposer runs.
    dispose1();
    expect(reg.has("r1")).toBe(true);
    dispose2();
    expect(reg.has("r1")).toBe(false);
  });

  test("trip on unknown run is a no-op", () => {
    const reg = new AbortRegistry();
    expect(reg.trip("nope")).toBe(false);
  });

  test("tripAll aborts every live controller", () => {
    const reg = new AbortRegistry();
    const c1 = new AbortController();
    const c2 = new AbortController();
    reg.register("r1", c1);
    reg.register("r2", c2);
    reg.tripAll();
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
  });

  test("unregister removes the entry", () => {
    const reg = new AbortRegistry();
    reg.register("r1", new AbortController());
    reg.unregister("r1");
    expect(reg.has("r1")).toBe(false);
    expect(reg.elapsedMs("r1")).toBeUndefined();
  });
});

describe("AbortRegistry — elapsedMs (pause-aware)", () => {
  test("elapsedMs tracks injected clock, not wall-clock", () => {
    const clk = fakeClock(1_000_000);
    const reg = new AbortRegistry(clk.now);
    reg.register("r1", new AbortController());
    expect(reg.elapsedMs("r1")).toBe(0);
    clk.advance(5_000);
    expect(reg.elapsedMs("r1")).toBe(5_000);
    clk.advance(10_000);
    expect(reg.elapsedMs("r1")).toBe(15_000);
  });

  test("re-registering a run (new process) resets elapsed", () => {
    const clk = fakeClock(0);
    const reg = new AbortRegistry(clk.now);
    reg.register("r1", new AbortController());
    clk.advance(60_000);
    expect(reg.elapsedMs("r1")).toBe(60_000);
    reg.unregister("r1");
    clk.advance(600_000); // simulate 10 minutes of daemon pause
    reg.register("r1", new AbortController());
    // Brand-new entry — pause time does NOT count.
    expect(reg.elapsedMs("r1")).toBe(0);
    clk.advance(1_000);
    expect(reg.elapsedMs("r1")).toBe(1_000);
  });

  test("elapsedMs is undefined for unknown runs", () => {
    const reg = new AbortRegistry();
    expect(reg.elapsedMs("nope")).toBeUndefined();
  });
});

describe("AbortRegistry — properties", () => {
  test("elapsed is always non-negative under monotonic clocks", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 50 }), (advances) => {
        const clk = fakeClock(0);
        const reg = new AbortRegistry(clk.now);
        reg.register("r", new AbortController());
        let totalAdvance = 0;
        for (const d of advances) {
          clk.advance(d);
          totalAdvance += d;
          const e = reg.elapsedMs("r");
          expect(e).toBeDefined();
          expect(e).toBeGreaterThanOrEqual(0);
          expect(e).toBe(totalAdvance);
        }
      }),
    );
  });

  test("unregister+register cycle truly resets elapsed regardless of pause length", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (preRun, pause, postRun) => {
          const clk = fakeClock(0);
          const reg = new AbortRegistry(clk.now);
          reg.register("r", new AbortController());
          clk.advance(preRun);
          reg.unregister("r");
          clk.advance(pause);
          reg.register("r", new AbortController());
          clk.advance(postRun);
          expect(reg.elapsedMs("r")).toBe(postRun);
        },
      ),
    );
  });
});
