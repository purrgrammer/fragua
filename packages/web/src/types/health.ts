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

export type HealthStatus = "loading" | "connected" | "error";

export interface HealthContextValue {
  status: HealthStatus;
  error: string | null;
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
