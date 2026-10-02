import {
  deleteDaemonLock,
  deleteDaemonLockIfMatches,
  deleteServerEndpoint,
  forceDeleteDaemonLockRow,
  insertDaemonEvent,
  insertDaemonLock,
  selectDaemonEvents,
  selectDaemonEventsByRun,
  selectDaemonLock,
  selectLatestDaemonLifecycleEvent,
  selectServerEndpoint,
  updateDaemonLockHeartbeat,
  upsertDaemonLock,
  upsertServerEndpoint,
} from "./daemon-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import type {
  DaemonEvent,
  DaemonEventRow,
  DaemonLockResult,
  DaemonLockRow,
  GetDaemonEventsOpts,
  ServerEndpointRow,
  SweepResult,
} from "./types.ts";

export function appendDaemonEvent(
  ctx: StoreCtx,
  event: DaemonEvent,
  opts?: { runId?: string },
): { seq: number; ts: number } {
  const payload = ctx.validatePayload(event.payload);
  const ts = ctx.now();
  const runId = opts?.runId ?? null;
  let seq = 0;
  ctx.writeTxn(() => {
    seq = insertDaemonEvent(ctx.db, event.type, payload, ts, runId);
  });
  return { seq, ts };
}

export function getDaemonEvents(ctx: StoreCtx, opts: GetDaemonEventsOpts = {}): DaemonEventRow[] {
  const sinceSeq = opts.sinceSeq ?? 0;
  const limit = opts.limit ?? -1;
  const rows =
    opts.runId != null
      ? selectDaemonEventsByRun(ctx.db, opts.runId, sinceSeq, limit)
      : selectDaemonEvents(ctx.db, sinceSeq, limit);
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: JSON.parse(r.payload),
    ts: r.ts,
    runId: r.run_id,
  }));
}

export function latestDaemonLifecycleEvent(ctx: StoreCtx): DaemonEventRow | null {
  const r = selectLatestDaemonLifecycleEvent(ctx.db);
  if (r == null) return null;
  return {
    seq: r.seq,
    type: r.type,
    payload: JSON.parse(r.payload),
    ts: r.ts,
    runId: r.run_id,
  };
}

export function acquireDaemonLock(ctx: StoreCtx, pid: number, hostname: string): DaemonLockResult {
  const now = ctx.now();
  let result: DaemonLockResult | null = null;

  ctx.writeTxn(() => {
    const existing = currentDaemonLock(ctx);
    if (existing != null) {
      result = { acquired: false, current: existing };
      return;
    }
    insertDaemonLock(ctx.db, pid, hostname, now);
    result = {
      acquired: true,
      current: { pid, hostname, startedAt: now, heartbeatAt: now },
    };
  });
  return result!;
}

export function forceAcquireDaemonLock(ctx: StoreCtx, pid: number, hostname: string): DaemonLockResult {
  const now = ctx.now();
  let current!: DaemonLockRow;
  ctx.writeTxn(() => {
    upsertDaemonLock(ctx.db, pid, hostname, now);
    current = { pid, hostname, startedAt: now, heartbeatAt: now };
  });
  return { acquired: true, current };
}

export function heartbeatDaemonLock(ctx: StoreCtx, pid: number): void {
  const now = ctx.now();
  ctx.writeTxn(() => {
    updateDaemonLockHeartbeat(ctx.db, pid, now);
  });
}

export function releaseDaemonLock(ctx: StoreCtx, pid: number): void {
  ctx.writeTxn(() => {
    deleteDaemonLock(ctx.db, pid);
  });
}

export function forceDeleteDaemonLock(ctx: StoreCtx): void {
  ctx.writeTxn(() => {
    forceDeleteDaemonLockRow(ctx.db);
  });
}

export function evictDaemonLockIfStale(
  ctx: StoreCtx,
  opts: {
    ttlMs: number;
    now?: () => number;
    isHolderAlive?: (lock: DaemonLockRow) => boolean;
  },
): { evicted: boolean; swept?: SweepResult; stalePid?: number; priorHeartbeatAt?: number } {
  const lock = currentDaemonLock(ctx);
  if (lock == null) return { evicted: false };
  const now = opts.now ?? ctx.now;
  const nowMs = now();
  const stale = nowMs - lock.heartbeatAt > opts.ttlMs;
  // Keep a live holder's lock: skip only when the heartbeat is fresh AND
  // (no liveness probe was supplied, or the probe says the holder is alive).
  // A stale heartbeat evicts regardless of the probe (TTL takes precedence).
  if (!stale && (opts.isHolderAlive == null || opts.isHolderAlive(lock))) {
    return { evicted: false };
  }
  // Guarded delete FIRST, in ONE statement: a daemon that re-acquired between
  // the snapshot above and this write installed a fresh pid/heartbeat, so the
  // WHERE clause misses and its live lock is never clobbered.
  //
  // The sweep must not run before it. Sweeping first buys nothing — a crash
  // in between is already covered, because every daemon boot runs
  // `startupSweep` unconditionally — while costing correctness: on a lost
  // race the guard spares the new holder's lock but the sweep has already
  // flipped its `running` rows to `queued` underneath it. All the ordering
  // gives up is the `priorHeartbeatAt` activeMs credit in that crash window.
  let deleted = false;
  ctx.writeTxn(() => {
    deleted = deleteDaemonLockIfMatches(ctx.db, lock.pid, lock.heartbeatAt);
  });
  if (!deleted) return { evicted: false };
  const sweepStart = ctx.now();
  const swept = ctx.store.startupSweep({ priorHeartbeatAt: lock.heartbeatAt });
  // Mirror the daemon's direct-takeover audit trail so a harness-supervised
  // recovery is visible in `daemon_events`.
  appendDaemonEvent(ctx, {
    type: "daemon.reaper_took_over",
    payload: {
      priorPid: lock.pid,
      priorHostname: lock.hostname,
      priorHeartbeatAt: lock.heartbeatAt,
      staleForMs: Math.max(0, nowMs - lock.heartbeatAt),
    },
  });
  appendDaemonEvent(ctx, {
    type: "daemon.sweep_completed",
    payload: {
      requeued: swept.requeued.length,
      quarantined: swept.quarantined.length,
      durationMs: Math.max(0, ctx.now() - sweepStart),
    },
  });
  return { evicted: true, swept, stalePid: lock.pid, priorHeartbeatAt: lock.heartbeatAt };
}

export function currentDaemonLock(ctx: StoreCtx): DaemonLockRow | null {
  const row = selectDaemonLock(ctx.db);
  if (row == null) return null;
  return {
    pid: row.pid,
    hostname: row.hostname,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  };
}

export function currentServerEndpoint(ctx: StoreCtx): ServerEndpointRow | null {
  const row = selectServerEndpoint(ctx.db);
  if (row == null) return null;
  return {
    url: row.url,
    port: row.port,
    pid: row.pid,
    startedAt: row.started_at,
    harnessVersion: row.harness_version,
  };
}

/** Publish where the HTTP server is reachable, after the listener binds.
 *  Written by the harness's in-process server or a standalone `fragua serve`. */
export function setServerEndpoint(
  ctx: StoreCtx,
  args: { url: string; port: number; pid: number; version: string | null },
): void {
  ctx.writeTxn(() => {
    upsertServerEndpoint(ctx.db, args.url, args.port, args.pid, ctx.now(), args.version);
  });
}

/** Clear the endpoint on clean shutdown. pid-scoped — a server that already
 *  rebound under a new pid isn't erased by a late closer. */
export function clearServerEndpoint(ctx: StoreCtx, pid: number): void {
  ctx.writeTxn(() => {
    deleteServerEndpoint(ctx.db, pid);
  });
}
