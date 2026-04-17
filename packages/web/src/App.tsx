// Top-level layout for the web UI. Hosts a persistent header (swarm brand
// + health badge) and mounts the router for the pipelines list / detail
// routes. The router is injectable so tests can swap in `createMemoryRouter`.

import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { type ApiClient, createApiClient } from "./lib/api.ts";
import { createRoutes } from "./lib/router.tsx";

export type HealthStatus = "loading" | "connected" | "error";

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

  // Stable client reference — avoids re-running the health effect per render
  // and lets the router share the same client instance.
  const client = useMemo(() => apiClient ?? createApiClient(), [apiClient]);

  // Build the router once per client. If the caller injects one, prefer it.
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

  return (
    <div className="h-dvh flex flex-col bg-slate-50 text-slate-900 font-sans">
      <header className="flex items-center justify-between border-b border-slate-200 px-8 py-4 bg-white">
        <h1 className="text-2xl font-semibold tracking-tight">swarm</h1>
        <HealthBadge status={status} error={error} />
      </header>
      {/* `flex-1 min-h-0` lets routes opt into full-height layouts (e.g. the
          pipeline-detail conversation); `overflow-auto` keeps long list pages
          (PipelinesList) scrolling normally when their content exceeds the
          viewport. */}
      <main className="flex-1 min-h-0 overflow-auto p-8">
        <RouterProvider router={activeRouter} />
      </main>
    </div>
  );
}

interface HealthBadgeProps {
  status: HealthStatus;
  error: string | null;
}

function HealthBadge({ status, error }: HealthBadgeProps): JSX.Element {
  const label = status === "loading" ? "connecting…" : status === "connected" ? "connected" : "error";
  const tone =
    status === "connected"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "error"
        ? "bg-rose-100 text-rose-800 border-rose-300"
        : "bg-slate-100 text-slate-700 border-slate-300";

  return (
    <span
      aria-live="polite"
      data-testid="health-badge"
      data-status={status}
      title={error ?? undefined}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${
          status === "connected" ? "bg-emerald-500" : status === "error" ? "bg-rose-500" : "bg-slate-400"
        }`}
      />
      {label}
    </span>
  );
}
