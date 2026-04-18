// Discovery + auto-start helper used by `swarm run` (and anything else
// that wants to talk to a locally-running daemon).
//
// Design: keep this tiny. Rendezvous reading + a health probe + an
// auto-start shell-out to `daemonStartCommand` is the whole surface.
// Everything else (HTTP contract, retries, error shapes) lives at the
// call site, which knows what to do when a specific request fails.

import { isPidAlive, readRendezvous } from "@swarm/server";
import { daemonStartCommand } from "../commands/daemon.ts";

export type EnsureDaemonResult =
  | { ok: true; port: number; baseUrl: string }
  | { ok: false; code: "not_running" | "autostart_failed" | "health_check_failed"; message: string };

export interface EnsureDaemonOptions {
  /** Project root. Same semantics as `swarm daemon start --cwd`. */
  cwd: string;
  /**
   * When true and no daemon is running, spawn one via
   * `daemonStartCommand`. When false, return `not_running`. Default
   * true — matches the "fire and forget" UX of `swarm run`.
   */
  autostart?: boolean;
  /** Optional port override for auto-start. */
  port?: number;
}

/**
 * Return a live daemon's `baseUrl`, starting it first if needed.
 *
 * The probe is two-stage: (1) rendezvous file present + pid alive,
 * (2) `/health` returns 2xx. Either miss triggers the autostart
 * branch (if enabled). Stale rendezvous (pid dead) is handled by
 * `daemonStartCommand`, which removes it before spawning.
 */
export async function ensureDaemonRunning(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const autostart = opts.autostart ?? true;

  // Fast path: rendezvous present + pid alive + /health responds.
  const alive = await probeExisting(opts.cwd);
  if (alive) return alive;

  if (!autostart) {
    return {
      ok: false,
      code: "not_running",
      message: "daemon not running. Start it with `swarm daemon start`, or drop --no-autostart to auto-start.",
    };
  }

  const code = await daemonStartCommand({
    cwd: opts.cwd,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });
  if (code !== 0) {
    return { ok: false, code: "autostart_failed", message: `daemonStartCommand returned exit code ${code}` };
  }

  // Re-probe after a successful start — rendezvous is guaranteed to
  // exist at this point (daemonStartCommand waited on it before
  // returning).
  const afterStart = await probeExisting(opts.cwd);
  if (afterStart) return afterStart;
  return {
    ok: false,
    code: "health_check_failed",
    message: "daemon started but /health didn't respond — check `.swarm/daemon/daemon.log`.",
  };
}

async function probeExisting(cwd: string): Promise<{ ok: true; port: number; baseUrl: string } | undefined> {
  const r = await readRendezvous(cwd);
  if (!r) return undefined;
  if (!isPidAlive(r.pid)) return undefined;
  const baseUrl = `http://127.0.0.1:${r.port}`;
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return { ok: true, port: r.port, baseUrl };
}
