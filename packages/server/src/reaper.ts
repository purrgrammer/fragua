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
// `fragua daemon` doesn't have to wait out the TTL again.
//
// The reaper is IDEMPOTENT: calling it while a live daemon is heart-
// beating is a no-op (the TTL check exits early).

import { DAEMON_LOCK_TTL_MS, type IDaemonCoordinator, type IEventWriter, type SweepResult } from "@fragua/store";

/** Heartbeat staleness threshold. One source of truth with the daemon lock's
 * own TTL so the reaper and the daemon can't drift; re-exported under the
 * reaper's historical name for existing callers. */
export { DAEMON_LOCK_TTL_MS as DEFAULT_REAP_TTL_MS };

export interface ReapResult {
  /** True when the reaper actually ran a sweep + cleared the lock. */
  reaped: boolean;
  /** Sweep outcome when `reaped` — number of runs requeued / quarantined. */
  swept?: SweepResult;
  /** Pid that held the stale lock, when `reaped`. */
  stalePid?: number;
}

export interface ReapOptions {
  store: IEventWriter & IDaemonCoordinator;
  /** Heartbeat staleness threshold. Defaults to {@link DAEMON_LOCK_TTL_MS}. */
  ttlMs?: number;
  /** Wall-clock provider (testing). */
  now?: () => number;
}

/**
 * Look for a stale `daemon_lock` row and, if found, sweep orphan runs +
 * release the lock. Safe to call from any process; the sweep runs inside
 * the store's own transaction. Returns `{reaped: false}` when the lock
 * is fresh or absent.
 *
 * Delegates to the store's `evictDaemonLockIfStale` so the TTL check, the
 * sweep (crediting pre-crash active time via `priorHeartbeatAt`), the
 * pid+heartbeat-guarded delete, and the `daemon.reaper_took_over` /
 * `daemon.sweep_completed` audit events all land in one place — the reaper
 * and the daemon can't disagree about what a stale-lock recovery does.
 */
export function reapStaleDaemon(opts: ReapOptions): ReapResult {
  const evictOpts: Parameters<IDaemonCoordinator["evictDaemonLockIfStale"]>[0] = {
    ttlMs: opts.ttlMs ?? DAEMON_LOCK_TTL_MS,
  };
  if (opts.now) evictOpts.now = opts.now;
  const r = opts.store.evictDaemonLockIfStale(evictOpts);
  if (!r.evicted) return { reaped: false };
  const result: ReapResult = { reaped: true };
  if (r.swept) result.swept = r.swept;
  if (r.stalePid != null) result.stalePid = r.stalePid;
  return result;
}
