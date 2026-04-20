// Stale-daemon reaper tests. Exercises all four branches:
//   - no lock row           → no-op
//   - fresh heartbeat       → no-op
//   - stale heartbeat       → sweep + lock cleared
//   - stale + orphan run    → run requeued, sweep result returned

import { afterEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { reapStaleDaemon } from "../src/reaper.ts";

let store: SqliteStore | null = null;

afterEach(() => {
  if (store != null) store.close();
  store = null;
});

function fresh(): SqliteStore {
  const s = new SqliteStore({ path: ":memory:" });
  store = s;
  return s;
}

describe("reapStaleDaemon", () => {
  test("no lock row → reaped: false", () => {
    const s = fresh();
    const r = reapStaleDaemon({ store: s, ttlMs: 30_000 });
    expect(r.reaped).toBe(false);
    expect(r.swept).toBeUndefined();
  });

  test("fresh heartbeat within TTL → reaped: false", () => {
    const s = fresh();
    s.forceAcquireDaemonLock(4242, "host-1");
    // Heartbeat was just written by forceAcquireDaemonLock.
    const r = reapStaleDaemon({ store: s, ttlMs: 30_000 });
    expect(r.reaped).toBe(false);
    expect(s.currentDaemonLock()?.pid).toBe(4242);
  });

  test("stale heartbeat + no runs → reaped: true, lock cleared, sweep empty", () => {
    const s = fresh();
    s.forceAcquireDaemonLock(4242, "host-1");
    const now = () => Date.now() + 60_000;
    const r = reapStaleDaemon({ store: s, ttlMs: 30_000, now });
    expect(r.reaped).toBe(true);
    expect(r.stalePid).toBe(4242);
    expect(r.swept?.requeued ?? []).toEqual([]);
    expect(s.currentDaemonLock()).toBeNull();
  });

  test("stale heartbeat + a running orphan → run is requeued by the sweep", () => {
    const s = fresh();
    s.saveWorkflow("wf", "t", "digraph {}");
    s.enqueueRun({ runId: "orphan-run", workflowSha: "wf" });
    s.claimNextRun(1); // flips status → running
    s.forceAcquireDaemonLock(4242, "host-1");

    const now = () => Date.now() + 60_000;
    const r = reapStaleDaemon({ store: s, ttlMs: 30_000, now });
    expect(r.reaped).toBe(true);
    expect(r.swept?.requeued).toContain("orphan-run");
    expect(s.getState("orphan-run")?.status).toBe("queued");
  });

  test("idempotent — calling twice on a stale lock is safe", () => {
    const s = fresh();
    s.forceAcquireDaemonLock(4242, "host-1");
    const now = () => Date.now() + 60_000;
    const first = reapStaleDaemon({ store: s, ttlMs: 30_000, now });
    expect(first.reaped).toBe(true);
    const second = reapStaleDaemon({ store: s, ttlMs: 30_000, now });
    expect(second.reaped).toBe(false); // lock already cleared
  });
});
