// The supervisor's heartbeat is the daemon's only view of whether it still
// holds `daemon_lock`. A row evicted underneath it (a stale-heartbeat reap
// after the host slept, an operator stop, a takeover) must surface as
// `onLockLost` exactly once, so the daemon stops acting as the singleton.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { startSupervisor } from "../src/supervisor.ts";

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("supervisor — lost daemon_lock", () => {
  test("a heartbeat that finds the row held by another pid fires onLockLost once", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.acquireDaemonLock(1, "h");
    const ctrl = new AbortController();
    let lost = 0;
    const sup = startSupervisor({
      store,
      registry: new AbortRegistry(),
      pid: 2,
      shutdownSignal: ctrl.signal,
      tickMs: 5,
      heartbeatIntervalMs: 5,
      onLockLost: () => {
        lost += 1;
      },
    });
    await settle(60);
    ctrl.abort();
    await sup.promise;
    expect(lost).toBe(1);
    // The owner's heartbeat was never touched by the intruder.
    expect(store.currentDaemonLock()?.pid).toBe(1);
    store.close();
  });

  test("the owner's heartbeat keeps advancing and never reports a lost lock", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.acquireDaemonLock(7, "h");
    const before = store.currentDaemonLock()!.heartbeatAt;
    const ctrl = new AbortController();
    let lost = 0;
    const sup = startSupervisor({
      store,
      registry: new AbortRegistry(),
      pid: 7,
      shutdownSignal: ctrl.signal,
      tickMs: 5,
      heartbeatIntervalMs: 5,
      onLockLost: () => {
        lost += 1;
      },
    });
    await settle(60);
    ctrl.abort();
    await sup.promise;
    expect(lost).toBe(0);
    expect(store.currentDaemonLock()!.heartbeatAt).toBeGreaterThan(before);
    store.close();
  });

  test("a row evicted mid-run is noticed on the next heartbeat", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.acquireDaemonLock(3, "h");
    const ctrl = new AbortController();
    let lost = 0;
    const sup = startSupervisor({
      store,
      registry: new AbortRegistry(),
      pid: 3,
      shutdownSignal: ctrl.signal,
      tickMs: 5,
      heartbeatIntervalMs: 5,
      onLockLost: () => {
        lost += 1;
      },
    });
    await settle(30);
    expect(lost).toBe(0);
    store.forceDeleteDaemonLock();
    await settle(40);
    ctrl.abort();
    await sup.promise;
    expect(lost).toBe(1);
    store.close();
  });
});
