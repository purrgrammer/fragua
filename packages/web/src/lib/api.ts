// Thin fetch client for the @swarm/server REST surface.
//
// We only expose what the scaffold needs (`/health`). Further endpoints —
// `/pipelines`, `/pipelines/:id`, SSE event stream, interview — are added in
// tasks 06+. Keeping this file narrow prevents typed surface churn every
// time a route changes shape server-side.
//
// The client accepts an injectable `fetch` so tests can stub without poking
// globals. Default wires to `globalThis.fetch`, which Vite/Bun both provide.

export interface HealthResponse {
  ok: boolean;
}

export interface ApiClientOptions {
  /** Base URL prefix (usually "/api" in dev, where Vite proxies to the server). */
  baseUrl?: string;
  /** Swap-in for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "/api";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async health(): Promise<HealthResponse> {
      const res = await fetchImpl(`${baseUrl}/health`);
      if (!res.ok) {
        throw new Error(`GET ${baseUrl}/health → ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as unknown;
      // Narrow defensively: a proxy misconfiguration can easily return HTML.
      if (typeof body !== "object" || body === null || typeof (body as { ok?: unknown }).ok !== "boolean") {
        throw new Error(`GET ${baseUrl}/health → malformed response`);
      }
      return body as HealthResponse;
    },
  };
}
