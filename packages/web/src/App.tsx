// Top-level layout for the web UI. At task-05 scope this is just a shell
// with a server-health badge that proves the React app can reach the Hono
// server through the Vite dev proxy. Subsequent tasks add the pipelines
// sidebar, graph view, timeline, and drilldown panes.

import { useEffect, useState } from "react";
import { type ApiClient, createApiClient } from "./lib/api.ts";

export type HealthStatus = "loading" | "connected" | "error";

export interface AppProps {
  /** Injectable client so tests can stub `fetch` without touching globals. */
  apiClient?: ApiClient;
}

export function App({ apiClient }: AppProps = {}): JSX.Element {
  const [status, setStatus] = useState<HealthStatus>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Re-create the client inside the effect when none is injected so SSR-
    // style env swaps (e.g. happy-dom bootstrapping) are honoured.
    const client = apiClient ?? createApiClient();
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
  }, [apiClient]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-8 font-sans">
      <header className="flex items-center justify-between border-b border-slate-200 pb-4 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">swarm</h1>
        <HealthBadge status={status} error={error} />
      </header>
      <main>
        <p className="text-slate-600 text-sm">
          Web UI scaffold. Pipelines, graph, and timeline land in follow-up tasks.
        </p>
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
  // Colour tokens picked so the badge is legible without extra plugins.
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
