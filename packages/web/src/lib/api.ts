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
//   - GET /pipelines/:id/events  (SSE)         → getPipelineEventsUrl(id)
//   - GET /workflows                           → listWorkflows()
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
  /** Auto-generated pipeline title (Wave 2b). Falls back to `input` then
   * `workflowName` for display. */
  title?: string;
  /** Raw `$ARGUMENTS` captured on `pipeline.started.data.input`. Display
   * fallback when `title` is absent; also handy for tooltips. */
  input?: string;
}

/** Local mirror of the server's `NodeState`. */
export interface NodeState {
  nodeId: string;
  state: "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";
  lastEventSeq: number;
}

/**
 * Local mirror of the server's `PipelineDetail`.
 *
 * `workflowSource` — raw DOT string copied through from the first
 * `pipeline.started` event. The web UI parses this with `@swarm/core`'s
 * `parseDotSource` to recover the topology (nodes + edges + labels +
 * attrs) for the graph canvas. Absent when the run predates source
 * capture — consumers render an empty state instead of guessing edges
 * from the event stream.
 *
 * NOTE: there is intentionally NO `edges` field here. Topology lives in
 * the DOT source; the server is not a second parser.
 */
export interface PipelineDetail {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "running" | "success" | "fail" | "unknown";
  lastEventSeq: number;
  nodes: NodeState[];
  /** Raw DOT source when captured on `pipeline.started`; otherwise absent. */
  workflowSource?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  /** Auto-generated pipeline title — see PipelineSummary.title. */
  title?: string;
  /** Raw `$ARGUMENTS` — see PipelineSummary.input. */
  input?: string;
}

/**
 * Local mirror of the server's `WorkflowSummary` port. Declared here (rather
 * than imported from `@swarm/server`) for the same reason as
 * `PipelineSummary` — the web package deliberately keeps its dependency
 * surface narrow.
 */
export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
}

/** Local mirror of the server's `SkillSummary` port. */
export interface SkillSummary {
  name: string;
  description: string;
  version?: string;
  allowed_tools?: string[];
  location: string;
  skill_dir: string;
  sha256: string;
  bytes: number;
  scope: "project" | "user";
  source_dir: string;
  /** When set, the skill was discovered but excluded from the agent's
   * tier-1 catalog. The UI renders it greyed out with this tooltip. */
  disabled_reason?: string;
}

/** Local mirror of the server's `SkillDetail` port. `usage` is present
 * when the server was configured with a `runReader` so
 * `GET /skills/:name` could fold `local:load_skill` activations. */
export interface SkillDetail extends SkillSummary {
  body: string;
  usage?: { runs: string[]; count: number };
}

/**
 * Wave 5: local mirror of the server's `StepSnapshot`. One element per
 * `llm.start` event in a run, carrying the fully-assembled context the
 * agent saw for that call. Kept narrow (no method helpers, no deep
 * content typing) — the UI just displays these fields.
 */
export interface StepSnapshot {
  stepIdx: number;
  nodeId: string;
  iteration?: { n: number; max: number };
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  threadId?: string;
  fidelity?: string;
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  deniedTools: string[];
  settings?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    reasoning_effort?: string;
    stop?: string[];
  };
  messages: Array<{ role: string; content?: unknown; timestamp?: number }>;
  contextFiles: Array<{
    path: string;
    sha256: string;
    bytes: number;
    truncated: boolean;
    status: string;
    error?: string;
  }>;
  skills: Array<{
    name: string;
    location: string;
    sha256: string;
    bytes: number;
    scope: "project" | "user";
    source_dir: string;
  }>;
  budget?: {
    cumulative_cost_usd: number;
    cumulative_tokens: number;
    max_cost_usd?: number;
    run_max_cost_usd?: number;
  };
  cost?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    cost_usd: number;
  };
  finalText: string;
  stopReason?: string;
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

/**
 * Bulk historical-events payload. Mirrors the server's
 * `GET /pipelines/:id/events.json`. Every raw event from the run's
 * `events.jsonl` is included verbatim; we leave shape validation to the
 * reducer (which only reads fields it recognises and tolerates the rest).
 *
 * `lastSeq` matches the SSE `id:` frames — pass it back as
 * `Last-Event-ID` when opening the stream so SSE resumes where the
 * bootstrap left off.
 */
export interface PipelineEventsPayload {
  events: unknown[];
  lastSeq: number;
}

export interface ApiClient {
  /** Current baseUrl, exposed so URL helpers stay consistent with fetches. */
  readonly baseUrl: string;

  health(): Promise<HealthResponse>;
  listPipelines(): Promise<PipelineSummary[]>;
  getPipeline(id: string): Promise<PipelineDetail>;
  listWorkflows(): Promise<WorkflowSummary[]>;
  /** List all installed skills (`GET /skills`). `refresh: true` forces the
   * server to re-scan the filesystem instead of using its short TTL cache. */
  listSkills(opts?: { refresh?: boolean }): Promise<SkillSummary[]>;
  /** Full SKILL.md body + metadata (`GET /skills/:name`). 404 throws ApiError. */
  getSkill(name: string): Promise<SkillDetail>;
  /**
   * Fetch the full historical event array for a run. Used to bootstrap
   * the conversation reducer before subscribing to the SSE stream — the
   * UI never keeps a raw-event buffer in memory past the fold.
   */
  getPipelineEvents(id: string): Promise<PipelineEventsPayload>;
  /**
   * Wave 5: per-step snapshots. Each element is the fully-assembled
   * context for one `backend.run()` call (prompt, system prompt,
   * messages, tools, settings, context files, budget, cost). The
   * server computes this from the raw event stream; the UI just
   * renders.
   */
  getPipelineSteps(id: string): Promise<StepSnapshot[]>;

  // URL helpers — always return relative strings starting with the client's
  // `baseUrl` (default "/api"). Callers use these anywhere a URL is needed
  // as a string (fetch, EventSource, <img src>, <object data>, links).
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

    async listWorkflows(): Promise<WorkflowSummary[]> {
      return getJson("/workflows", (v): v is WorkflowSummary[] => Array.isArray(v) && v.every(isWorkflowSummary));
    },

    async listSkills(listOpts?: { refresh?: boolean }): Promise<SkillSummary[]> {
      const qs = listOpts?.refresh ? "?refresh=1" : "";
      return getJson(`/skills${qs}`, (v): v is SkillSummary[] => Array.isArray(v) && v.every(isSkillSummary));
    },

    async getSkill(name: string): Promise<SkillDetail> {
      return getJson(`/skills/${encodeURIComponent(name)}`, isSkillDetail);
    },

    async getPipelineEvents(id: string): Promise<PipelineEventsPayload> {
      return getJson(
        `/pipelines/${encodeURIComponent(id)}/events.json`,
        (v): v is PipelineEventsPayload =>
          typeof v === "object" &&
          v !== null &&
          Array.isArray((v as { events?: unknown }).events) &&
          typeof (v as { lastSeq?: unknown }).lastSeq === "number",
      );
    },

    async getPipelineSteps(id: string): Promise<StepSnapshot[]> {
      return getJson(
        `/pipelines/${encodeURIComponent(id)}/steps`,
        (v): v is StepSnapshot[] => Array.isArray(v) && v.every(isStepSnapshot),
      );
    },

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
    workflowSource?: unknown;
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
    (o.workflowSource === undefined || typeof o.workflowSource === "string") &&
    (o.costUsd === undefined || typeof o.costUsd === "number") &&
    (o.inputTokens === undefined || typeof o.inputTokens === "number") &&
    (o.outputTokens === undefined || typeof o.outputTokens === "number") &&
    (o.durationMs === undefined || typeof o.durationMs === "number")
  );
}

/**
 * Soft validator for `WorkflowSummary`. Accepts unknown extra fields so
 * future server additions don't break older clients. `label` is optional.
 */
function isWorkflowSummary(v: unknown): v is WorkflowSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { name?: unknown; path?: unknown; sha?: unknown; label?: unknown };
  return (
    typeof o.name === "string" &&
    typeof o.path === "string" &&
    typeof o.sha === "string" &&
    (o.label === undefined || typeof o.label === "string")
  );
}

function isSkillSummary(v: unknown): v is SkillSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    name?: unknown;
    description?: unknown;
    location?: unknown;
    sha256?: unknown;
    bytes?: unknown;
    scope?: unknown;
    source_dir?: unknown;
  };
  return (
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    typeof o.location === "string" &&
    typeof o.sha256 === "string" &&
    typeof o.bytes === "number" &&
    (o.scope === "project" || o.scope === "user") &&
    typeof o.source_dir === "string"
  );
}

function isSkillDetail(v: unknown): v is SkillDetail {
  if (!isSkillSummary(v)) return false;
  return typeof (v as { body?: unknown }).body === "string";
}

/**
 * Soft validator for `StepSnapshot`. Required fields: the identity
 * triple (`stepIdx`, `nodeId`, `startedAt`) and the two strings the UI
 * would otherwise crash on (`prompt`, `systemPrompt`). Everything else
 * is optional / tolerated — a malformed nested field shouldn't bounce
 * the whole inspector.
 */
function isStepSnapshot(v: unknown): v is StepSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    stepIdx?: unknown;
    nodeId?: unknown;
    startedAt?: unknown;
    prompt?: unknown;
    systemPrompt?: unknown;
  };
  return (
    typeof o.stepIdx === "number" &&
    typeof o.nodeId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.prompt === "string" &&
    typeof o.systemPrompt === "string"
  );
}
