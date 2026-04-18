import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, type RenderResult, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export interface RenderWithClientOptions extends Omit<RenderOptions, "wrapper"> {
  client?: QueryClient;
}

export function renderWithClient(
  ui: ReactElement,
  opts: RenderWithClientOptions = {},
): RenderResult & { client: QueryClient } {
  const { client: clientOpt, ...rest } = opts;
  const client = clientOpt ?? createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const result = render(ui, { ...rest, wrapper: Wrapper });
  return Object.assign(result, { client });
}

type RouteHandler = (req: { url: string; method: string; init?: RequestInit }) => Response | Promise<Response>;

/**
 * Install a URL-routing fake `fetch` for the duration of a test. The
 * returned `restore` puts back whatever was on `globalThis.fetch` before
 * the install. Routes are matched by exact URL OR by a predicate.
 *
 * Example:
 *   const { restore } = installFetchMock({
 *     "/api/pipelines": () => json([row1, row2]),
 *     "/api/health":    () => json({ ok: true }),
 *   });
 */
export function installFetchMock(
  routes: Record<string, RouteHandler> = {},
  fallback: RouteHandler = () => new Response("not found", { status: 404 }),
): { restore: () => void; calls: Array<{ url: string; method: string }> } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const handler = routes[url] ?? fallback;
    return handler({ url, method, init });
  };

  globalThis.fetch = impl as typeof globalThis.fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Build an `application/json` response. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
