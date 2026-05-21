// GET /health — liveness probe.
//
// Shape:
//   { ok: true }                                 — plain `fragua serve` (no daemon)
//   { ok: true, daemon: {...} }                  — running as the fragua daemon
//
// The `daemon` key lets the web UI distinguish "can I enqueue jobs?"
// from "view-only archive". Keys:
//   pid, port, startedAt, version                — straight from the rendezvous
//   concurrency                                  — active global cap
//   inflight                                     — count of rows in status='running'
//   queued                                       — count of rows in status='queued'
//
// The two counters are derived from the JobQueue on each request. It's
// cheap (indexed SELECT COUNT) and we don't poll `/health` often enough
// for it to matter.
//
// TUI + existing client code only assert `ok:true`; the extra key is
// additive and safe.
//
// NOTE: we intentionally do NOT bake the daemon info into the route
// factory itself — the daemon injects a small provider callback, and
// the standalone `fragua serve` path leaves it unset. That keeps
// `createServer()` free of daemon lifecycle concerns.

import type { IEventStore } from "@fragua/store";
import { Hono } from "hono";
import { reapStaleDaemon } from "../reaper.ts";

/** Daemons heartbeat at ~10s; treat 30s without one as dead. Matches
 * `DEFAULT_LOCK_TTL_MS` in `@fragua/daemon`. */
export const DAEMON_LIVENESS_TTL_MS = 30_000;

export interface DaemonInfoFromStoreOptions {
  store: IEventStore;
  /** ISO startup time of the *server* — only used in the placeholder
   * fallback if the lock row is missing `started_at` (it never is). */
  fallbackStartedAt?: string;
  /** CLI/server version, surfaced to the web UI. */
  version?: string;
  /** Heartbeat TTL. Defaults to {@link DAEMON_LIVENESS_TTL_MS}. */
  ttlMs?: number;
  /** Wall-clock provider (testing). */
  now?: () => number;
}

/**
 * Build a `daemonInfo` callback from the shared store. The daemon and the
 * server live in different processes; the SQLite store is their sync point.
 *
 * On each request:
 *  - Read `currentDaemonLock()`.
 *  - If absent OR heartbeat older than `ttlMs` → throw, so the health route
 *    omits the `daemon` key and the web UI shows "daemon not running".
 *  - Otherwise return a HealthDaemonInfo built from the lock row +
 *    `runStateCounts()`. `port` is 0 because the daemon process doesn't
 *    bind one; `concurrency` is 0 because it isn't recorded in the lock.
 */
export function daemonInfoFromStore(opts: DaemonInfoFromStoreOptions): () => HealthDaemonInfo {
  const ttl = opts.ttlMs ?? DAEMON_LIVENESS_TTL_MS;
  const now = opts.now ?? Date.now;
  const version = opts.version ?? "unknown";
  return () => {
    const lock = opts.store.currentDaemonLock();
    if (lock == null) throw new Error("daemon not running");
    if (now() - lock.heartbeatAt > ttl) {
      // Stale heartbeat: the daemon died without releasing. Sweep any
      // runs it had in flight and clear the lock row so the next
      // `fragua daemon` doesn't have to wait out the TTL. Idempotent —
      // safe to fire on every /health request when the lock is stale.
      reapStaleDaemon({ store: opts.store, ttlMs: ttl, now });
      throw new Error("daemon heartbeat stale");
    }
    const counts = opts.store.runStateCounts();
    return {
      pid: lock.pid,
      port: 0,
      startedAt: new Date(lock.startedAt).toISOString(),
      version,
      concurrency: 0,
      inflight: counts.running,
      queued: counts.queued,
    };
  };
}

export interface HealthDaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  concurrency: number;
  inflight: number;
  queued: number;
}

export interface HealthRouteOptions {
  /** When set, the result is merged into the `/health` response under
   * `daemon`. Called per request so counters stay fresh. */
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}

export function healthRoutes(opts: HealthRouteOptions = {}): Hono {
  const app = new Hono();
  app.get("/health", async (c) => {
    if (!opts.daemonInfo) return c.json({ ok: true });
    try {
      const info = await opts.daemonInfo();
      return c.json({ ok: true, daemon: info });
    } catch {
      // If the provider throws (e.g. closed SQLite handle during shutdown),
      // still report ok:true so liveness probes don't flap — just omit the
      // enrichment. Servers behind load balancers care about liveness, not
      // ergonomics.
      return c.json({ ok: true });
    }
  });
  return app;
}
