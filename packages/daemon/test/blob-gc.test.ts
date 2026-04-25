// Background blob GC loop. The driver wakes from sleep on a configured
// interval and calls `store.gcBlobs(maxRows)`; the test cuts the
// interval to ~10ms and asserts at least one sweep fires.

import { describe, expect, test } from "bun:test";
import { startBlobGc } from "../src/blob-gc.ts";
import { rig } from "./helpers.ts";

describe("startBlobGc", () => {
  test("sweeps at the configured interval and reports deletion counts", async () => {
    const r = rig();
    const ctrl = new AbortController();
    const sweeps: number[] = [];

    const gc = startBlobGc({
      store: r.store,
      shutdownSignal: ctrl.signal,
      intervalMs: 10,
      maxRows: 100,
      onSweep: (deleted) => sweeps.push(deleted),
    });

    // Allow ≥ 2 sweeps (≥ 30ms — first sweep at 10ms, second at 20ms).
    await new Promise((res) => setTimeout(res, 50));
    ctrl.abort();
    await gc.promise;

    expect(sweeps.length).toBeGreaterThanOrEqual(2);
    // No artifacts in the rig → every sweep deletes 0 files. The
    // assertion is that the sweep ran, not that anything was reaped.
    expect(sweeps.every((d) => d === 0)).toBe(true);
    r.store.close();
  });

  test("stops promptly when the shutdown signal fires", async () => {
    const r = rig();
    const ctrl = new AbortController();
    const gc = startBlobGc({
      store: r.store,
      shutdownSignal: ctrl.signal,
      intervalMs: 60_000, // long — must wake on signal, not on tick
    });
    ctrl.abort();
    // The promise should resolve far faster than 60s; if it doesn't,
    // the sleep helper isn't honouring the signal and the test times out.
    await Promise.race([
      gc.promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("gc loop didn't unblock on shutdown")), 1_000)),
    ]);
    r.store.close();
  });

  test("a sweep that throws does not crash the loop", async () => {
    const r = rig();
    // Replace gcBlobs with a method that throws once, then succeeds.
    let calls = 0;
    const orig = r.store.gcBlobs.bind(r.store);
    r.store.gcBlobs = (n?: number): { deleted: number } => {
      calls++;
      if (calls === 1) throw new Error("simulated FS error");
      return orig(n);
    };

    const ctrl = new AbortController();
    const sweeps: number[] = [];
    const gc = startBlobGc({
      store: r.store,
      shutdownSignal: ctrl.signal,
      intervalMs: 10,
      onSweep: (deleted) => sweeps.push(deleted),
    });
    await new Promise((res) => setTimeout(res, 40));
    ctrl.abort();
    await gc.promise;

    expect(calls).toBeGreaterThanOrEqual(2);
    // First call threw → no onSweep; second succeeded → onSweep called.
    expect(sweeps.length).toBeGreaterThanOrEqual(1);
    r.store.close();
  });
});
