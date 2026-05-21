import { type QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Toaster } from "./components/ui/sonner.tsx";
import { queries } from "./lib/queries.ts";
import { createQueryClient } from "./lib/query-client.ts";
import { createRoutes } from "./lib/router.tsx";
import { useGlobalEventStream } from "./lib/useGlobalEventStream.ts";
import { HealthContext, type HealthContextValue } from "./types/health.ts";

export type { HealthStatus } from "./types/health.ts";

export interface AppProps {
  /**
   * Injectable router so tests can drive routing with `createMemoryRouter`.
   * When omitted, we build a browser router from the standard route table.
   */
  router?: ReturnType<typeof createBrowserRouter>;
  /** Injectable query client so tests can scope cache to a single test. */
  queryClient?: QueryClient;
}

export function App({ router, queryClient }: AppProps = {}): JSX.Element {
  const qc = useMemo(() => queryClient ?? createQueryClient(), [queryClient]);
  const activeRouter = useMemo(() => router ?? createBrowserRouter(createRoutes()), [router]);

  return (
    <QueryClientProvider client={qc}>
      <Toaster />
      <GlobalFeedHost />
      <HealthProvider>
        <RouterProvider router={activeRouter} />
      </HealthProvider>
    </QueryClientProvider>
  );
}

/** Side-effect-only component: drives the global event feed atom and
 * cross-app run-query invalidation. Mounted once at the app root so
 * the SSE connection survives navigation and the feed buffer persists
 * across pages. Renders nothing. */
function GlobalFeedHost(): null {
  useGlobalEventStream();
  return null;
}

function HealthProvider({ children }: { children: ReactNode }): JSX.Element {
  const { data, isPending, error } = useQuery(queries.health());

  const value = useMemo<HealthContextValue>(() => {
    if (isPending) return { status: "loading", error: null };
    if (error) return { status: "error", error: error instanceof Error ? error.message : String(error) };
    if (data && !data.ok) return { status: "error", error: "server reported ok: false" };
    // Server is up but no daemon lock → job queue is offline. Show as
    // a distinct state so operators notice when the daemon crashed.
    if (data && !data.daemon) return { status: "no-daemon", error: null };
    return { status: "connected", error: null, daemon: data?.daemon };
  }, [isPending, error, data]);

  return <HealthContext.Provider value={value}>{children}</HealthContext.Provider>;
}
