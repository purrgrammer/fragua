// Connection-status enum + React context used by the sidebar footer.
//
// Lives outside `App.tsx` to avoid a circular import:
// `App` → `router` → `AppShell` → (would re-import `HealthStatus` from
// `App`). A standalone module flattens the graph.
//
// Why a context (not props through router options): `App` recreates
// the route tree only when its inputs change, but tests inject their
// own router (and assert on health-badge state flips). A context lets
// the badge re-render whenever `App` flips status without rebuilding
// the router or re-passing props through every layout boundary.

import { createContext, useContext } from "react";

/**
 * Connection state surfaced in the sidebar footer.
 *
 *   - `loading`     — first `/health` in flight
 *   - `connected`   — server is up AND the daemon heartbeat is fresh
 *   - `no-daemon`   — server is up but `/health` has no `daemon` key
 *                     (plain `fragua serve` OR the daemon process died /
 *                     its heartbeat went stale). Distinct from `error`
 *                     because the server itself is answering; distinct
 *                     from `connected` because the job queue is offline.
 *   - `error`       — server returned not-ok / transport error
 */
export type HealthStatus = "loading" | "connected" | "no-daemon" | "error";

/** Snapshot of the daemon, when the connected server is one. `undefined`
 * for plain `fragua serve` (no job queue → UI is read-only). */
export interface HealthDaemonSnapshot {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
  concurrency: number;
  inflight: number;
  queued: number;
}

export interface HealthContextValue {
  status: HealthStatus;
  error: string | null;
  /** `undefined` while loading or when the server is daemon-less. Set
   * to a snapshot when the latest `/health` response carried a `daemon`
   * key. Consumers use "daemon key absent" as the signal for the
   * "daemon not running" banner. */
  daemon?: HealthDaemonSnapshot;
}

const DEFAULT: HealthContextValue = { status: "connected", error: null };

export const HealthContext = createContext<HealthContextValue>(DEFAULT);

/**
 * Read the current connection state. Defaults to a "connected" stub
 * when no provider is mounted — keeps route-focused tests free of
 * provider boilerplate, while production always wraps via `App`.
 */
export function useHealth(): HealthContextValue {
  return useContext(HealthContext);
}
