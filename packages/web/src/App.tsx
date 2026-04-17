// Top-level wiring for the web UI. The persistent layout (sidebar +
// breadcrumb header + connection badge) lives in `components/AppShell`;
// this file's only job is:
//   1. Build / cache the API client.
//   2. Run the health probe and publish the result via `HealthContext`.
//   3. Mount the data-router. The sidebar footer reads the context, so
//      flipping status doesn't require rebuilding the route tree —
//      which means tests can inject their own router and still see
//      live status updates.

import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { type ApiClient, createApiClient } from "./lib/api.ts";
import { createRoutes } from "./lib/router.tsx";
import { HealthContext, type HealthStatus } from "./types/health.ts";

// Re-export for back-compat with existing callers (`HealthBadge`, the
// App test) that import `HealthStatus` from this module.
export type { HealthStatus } from "./types/health.ts";

export interface AppProps {
  /** Injectable client so tests can stub `fetch` without touching globals. */
  apiClient?: ApiClient;
  /**
   * Injectable router so tests can drive routing with `createMemoryRouter`.
   * When omitted, we build a browser router from the standard route table.
   */
  router?: ReturnType<typeof createBrowserRouter>;
}

export function App({ apiClient, router }: AppProps = {}): JSX.Element {
  const [status, setStatus] = useState<HealthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  // Stable client reference — avoids re-running the health effect per
  // render and lets the router share the same client instance.
  const client = useMemo(() => apiClient ?? createApiClient(), [apiClient]);

  // Build the router once per client. Status updates flow through
  // context, not through createRoutes options, so the tree is stable.
  const activeRouter = useMemo(() => router ?? createBrowserRouter(createRoutes({ api: client })), [router, client]);

  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then((res) => {
        if (cancelled) return;
        setStatus(res.ok ? "connected" : "error");
        if (!res.ok) setError("server reported ok: false");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const value = useMemo(() => ({ status, error }), [status, error]);

  return (
    <HealthContext.Provider value={value}>
      <RouterProvider router={activeRouter} />
    </HealthContext.Provider>
  );
}
