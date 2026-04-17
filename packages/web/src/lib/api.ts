// Thin fetch client for the @swarm/server REST surface.
//
// URL discipline — READ BEFORE EDITING:
//
//   Every client-to-server URL MUST be relative (starts with "/api/…") so
//   it resolves against the page origin AND gets intercepted by Vite's
//   `/api` proxy (configured in vite.config.ts → target http://localhost:3000).
//   Absolute URLs (http://..., window.location.origin + "/api/..."),
//   import.meta.env.VITE_*_URL constants, and any other host-qualified
//   form are banned — in dev they would resolve to localhost:5173 (the
//   Vite dev server) and 404.
//
//   To enforce this, every URL used in the client — whether for fetch(),
//   EventSource, <img src>, <object data>, or anywhere else — MUST come
//   from one of the exported helpers below. Components importing the
//   helpers is the single audit point; no component should hand-build a
//   "/api/..." string inline.
//
// Endpoints wired here:
//   - GET /health                              → health()
//   - GET /pipelines                           → listPipelines()
//   - GET /pipelines/:id                       → getPipeline(id)
//   - GET /pipelines/:id/graph.svg             → getPipelineGraph(id)
//                                                getPipelineGraphUrl(id)
//   - GET /pipelines/:id/events  (SSE)         → getPipelineEventsUrl(id)
//
// Test-injectable:
//   - `fetchImpl` → swap in a mock fetch.
//   - `baseUrl`   → override "/api" (e.g. for preview-environment tests).

export interface HealthResponse {
  ok: boolean;
}

/**
 * Subset of `PipelineSummary` the UI cares about. We intentionally don't
 * re-import from `@swarm/server` to keep the web package's dep surface
 * narrow — a local mirror is cheap and easy to evolve.
 *
 * Derived-metric fields (`costUsd`, `inputTokens`, `outputTokens`,
 * `durationMs`) mirror the server schema one-for-one; see
 * `packages/server/src/schemas.ts` for semantics. Defaults are zero for
 * the numeric totals and undefined for durations that can't be computed
 * (fewer than two events, unparseable timestamps).
 */
export interface PipelineSummary {
  runId: string;
  /** Raw workflow identifier — may be a path, basename, or SHA. */
  workflow?: string;
  /** Human-readable workflow name (basename, graph_id). Prefer for display. */
  workflowName?: string;
  startedAt: string;
  status: "running" | "success" | "fail" | "unknown";
  eventCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** ms between first and last event; undefined if not computable. */
  durationMs?: number;
}

/** Local mirror of the server's `NodeState`. */
export interface NodeState {
  nodeId: string;
  state: "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";
  lastEventSeq: number;
}

/** Local mirror of the server's `PipelineDetail`. */
export interface PipelineDetail {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "running" | "success" | "fail" | "unknown";
  lastEventSeq: number;
  nodes: NodeState[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

/**
 * Thrown for any non-2xx HTTP response from the API. Callers can branch on
 * `.status` to render status-specific fallbacks (e.g. 404 → empty state).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
  }
}

export interface ApiClientOptions {
  /**
   * Relative base prefix. Defaults to "/api" which is what the Vite dev
   * proxy intercepts. Override only for tests — production builds are
   * served from the same origin as the server, where the proxy doesn't
   * matter but the prefix stays consistent.
   */
  baseUrl?: string;
  /** Swap-in for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  /** Current baseUrl, exposed so URL helpers stay consistent with fetches. */
  readonly baseUrl: string;

  health(): Promise<HealthResponse>;
  listPipelines(): Promise<PipelineSummary[]>;
  getPipeline(id: string): Promise<PipelineDetail>;
  /** Returns the raw SVG document text. */
  getPipelineGraph(id: string): Promise<string>;

  // URL helpers — always return relative strings starting with the client's
  // `baseUrl` (default "/api"). Callers use these anywhere a URL is needed
  // as a string (fetch, EventSource, <img src>, <object data>, links).
  getPipelineGraphUrl(id: string): string;
  getPipelineEventsUrl(id: string): string;

  /** @deprecated Use getPipelineEventsUrl. Kept for existing callers. */
  pipelineEventsUrl(id: string): string;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? "/api";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  // Centralised URL builder. Every method below goes through this so the
  // `baseUrl` prefix lives in exactly one place. `path` must begin with
  // "/"; we don't try to be clever about joining.
  const url = (path: string): string => `${baseUrl}${path}`;

  async function getJson<T>(path: string, validate: (v: unknown) => v is T): Promise<T> {
    const u = url(path);
    const res = await fetchImpl(u);
    if (!res.ok) {
      throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
    }
    const body = (await res.json()) as unknown;
    if (!validate(body)) {
      throw new Error(`GET ${u} → malformed response`);
    }
    return body;
  }

  const getPipelineGraphUrl = (id: string): string => url(`/pipelines/${encodeURIComponent(id)}/graph.svg`);
  const getPipelineEventsUrl = (id: string): string => url(`/pipelines/${encodeURIComponent(id)}/events`);

  return {
    baseUrl,

    async health(): Promise<HealthResponse> {
      return getJson(
        "/health",
        (v): v is HealthResponse =>
          typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean",
      );
    },

    async listPipelines(): Promise<PipelineSummary[]> {
      return getJson("/pipelines", (v): v is PipelineSummary[] => Array.isArray(v) && v.every(isPipelineSummary));
    },

    async getPipeline(id: string): Promise<PipelineDetail> {
      return getJson(`/pipelines/${encodeURIComponent(id)}`, isPipelineDetail);
    },

    async getPipelineGraph(id: string): Promise<string> {
      // The server sends `image/svg+xml`; setting Accept makes intent
      // explicit and lets a misconfigured proxy fail loudly instead of
      // returning HTML.
      const u = getPipelineGraphUrl(id);
      const res = await fetchImpl(u, { headers: { Accept: "image/svg+xml" } });
      if (!res.ok) {
        throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
      }
      const text = await res.text();
      if (!text.includes("<svg")) {
        throw new Error(`GET ${u} → not an SVG document`);
      }
      return text;
    },

    getPipelineGraphUrl,
    getPipelineEventsUrl,
    // Back-compat alias. New callers should use getPipelineEventsUrl.
    pipelineEventsUrl: getPipelineEventsUrl,
  };
}

// ── Shape validators ─────────────────────────────────────────────────────
// We soft-validate the new metric fields: older server builds (pre-P5.06)
// may not include them, and rejecting those payloads would break the dev
// UX for operators running mixed versions. The validators require the
// core identity/status fields and coerce missing metrics to zero in the
// normalisers below.

function isPipelineSummary(v: unknown): v is PipelineSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    runId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    eventCount?: unknown;
    costUsd?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    durationMs?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.eventCount === "number" &&
    // Metric fields: accept number OR undefined (older servers).
    (o.costUsd === undefined || typeof o.costUsd === "number") &&
    (o.inputTokens === undefined || typeof o.inputTokens === "number") &&
    (o.outputTokens === undefined || typeof o.outputTokens === "number") &&
    (o.durationMs === undefined || typeof o.durationMs === "number")
  );
}

function isPipelineDetail(v: unknown): v is PipelineDetail {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    runId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    lastEventSeq?: unknown;
    nodes?: unknown;
    costUsd?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    durationMs?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.lastEventSeq === "number" &&
    Array.isArray(o.nodes) &&
    (o.costUsd === undefined || typeof o.costUsd === "number") &&
    (o.inputTokens === undefined || typeof o.inputTokens === "number") &&
    (o.outputTokens === undefined || typeof o.outputTokens === "number") &&
    (o.durationMs === undefined || typeof o.durationMs === "number")
  );
}
