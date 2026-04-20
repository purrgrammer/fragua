// Stale-daemon reaper. See ARCHITECTURE.md §6 for lifecycle.
//
// Scenario: a daemon process crashed (SIGKILL, OOM, host reboot) without
// releasing its lock. The lock row in `daemon_lock` still names the dead
// pid, and any runs it had in-flight stay in `status="running"` until
// the NEXT daemon start triggers `startupSweep`. Between crash and next
// boot, the UI reports stale "running" state indefinitely and enqueues
// succeed silently (they just sit forever).
//
// Fix: reap on observation. Any process with store access (the server's
// /health path, a dedicated tick) can detect a stale heartbeat and run
// the same sweep startupSweep does, plus clear the lock row so the next
// `swarm daemon` doesn't have to wait out the TTL again.
//
// The reaper is IDEMPOTENT: calling it while a live daemon is heart-
// beating is a no-op (the TTL check exits early).

import type { IEventStore, SweepResult } from "@swarm/store";

/** Heartbeats are ~10s; 30s without one is the established "dead" line.
 * Kept here (not imported from /routes/health.ts) so the reaper has no
 * circular dep on the health module. */
export const DEFAULT_REAP_TTL_MS = 30_000;

export interface ReapResult {
  /** True when the reaper actually ran a sweep + cleared the lock. */
  reaped: boolean;
  /** Sweep outcome when `reaped` — number of runs requeued / quarantined. */
  swept?: SweepResult;
  /** Pid that held the stale lock, when `reaped`. */
  stalePid?: number;
}

export interface ReapOptions {
  store: IEventStore;
  /** Heartbeat staleness threshold. Defaults to {@link DEFAULT_REAP_TTL_MS}. */
  ttlMs?: number;
  /** Wall-clock provider (testing). */
  now?: () => number;
}

/**
 * Look for a stale `daemon_lock` row and, if found, sweep orphan runs +
 * release the lock. Safe to call from any process; the sweep runs inside
 * the store's own transaction. Returns `{reaped: false}` when the lock
 * is fresh or absent.
 */
export function reapStaleDaemon(opts: ReapOptions): ReapResult {
  const ttl = opts.ttlMs ?? DEFAULT_REAP_TTL_MS;
  const now = opts.now ?? Date.now;
  const lock = opts.store.currentDaemonLock();
  if (lock == null) return { reaped: false };
  if (now() - lock.heartbeatAt <= ttl) return { reaped: false };

  const swept = opts.store.startupSweep();
  // Delete the stale row via force-acquire + release. There is no
  // direct "clear any lock" primitive; this is the store's sanctioned
  // compound that force-acquireDaemonLock exists for (daemon takeover).
  opts.store.forceAcquireDaemonLock(process.pid, "reaper");
  opts.store.releaseDaemonLock(process.pid);

  return { reaped: true, swept, stalePid: lock.pid };
}
