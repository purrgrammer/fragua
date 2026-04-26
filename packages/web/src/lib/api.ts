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
// Tests mock at the `globalThis.fetch` boundary (spyOn) or at the module
// boundary (`mock.module`) — both standard bun patterns, no in-module
// injection seam required.

import type { AgentMessage } from "@swarm/types";

export const BASE_URL = "/api";

export interface HealthResponse {
  ok: boolean;
  /**
   * Present when the server runs as the swarm daemon (exposes a job
   * queue + process supervisor). Absent for plain `swarm serve`, which
   * the UI treats as a read-only archive view.
   */
  daemon?: {
    pid: number;
    port: number;
    startedAt: string;
    version: string;
    concurrency: number;
    inflight: number;
    queued: number;
  };
}

export interface RunSummary {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "queued" | "running" | "paused" | "success" | "fail" | "canceled" | "unknown";
  eventCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  title?: string;
  input?: string;
}

export interface NodeState {
  nodeId: string;
  state: "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";
  lastEventSeq: number;
}

/**
 * `workflowSource` is the raw DOT captured on `run.started`; absent
 * when the run predates source capture. There is intentionally NO
 * `edges` field — topology lives in the DOT source and is parsed
 * client-side by `@swarm/core`'s `parseDotSource` so the server isn't a
 * second parser.
 */
/** `(from, to)` pair for an edge the executor traversed — see server's
 *  `SelectedEdge` schema. Ordered log; duplicates allowed. */
export interface SelectedEdge {
  from: string;
  to: string;
}

export interface RunDetail {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "queued" | "running" | "paused" | "success" | "fail" | "canceled" | "unknown";
  lastEventSeq: number;
  nodes: NodeState[];
  selectedEdges: SelectedEdge[];
  workflowSource?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  title?: string;
  input?: string;
}

export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
}

/** Full workflow, including the raw DOT source. Fetched on demand by
 *  the workflow detail page — the list endpoint stays cheap. The DOT is
 *  parsed client-side by `@swarm/core`'s `parseDotSource`; the server
 *  never parses DOT itself. */
export interface WorkflowDetail extends WorkflowSummary {
  source: string;
}

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
  disabled_reason?: string;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  usage?: { runs: string[]; count: number };
}

export interface StepSnapshot {
  stepIdx: number;
  /** Stream seq of the originating `llm.start`. Joins this snapshot to
   * the SQL cost-aggregate row produced by the server. */
  startSeq: number;
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
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
  finalText: string;
  stopReason?: string;
}

/** Thrown for any non-2xx HTTP response. Callers can branch on `.status`
 *  to render status-specific fallbacks (e.g. 404 → empty state). */
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

export interface RunEventsPayload {
  events: unknown[];
  lastSeq: number;
}

export type JobStatus = "queued" | "running" | "success" | "failed" | "canceled";

export interface JobSummary {
  id: string;
  runId: string;
  workflow: string;
  input?: string;
  model?: string;
  status: JobStatus;
  priority: number;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  childPid?: number;
  error?: string;
  /** True by default (daemon-spawned runs are isolated). `false` only
   * when the client explicitly opted out via `--no-worktree`. */
  worktree: boolean;
}

// ── Private helpers ─────────────────────────────────────────────────

const url = (path: string): string => `${BASE_URL}${path}`;

async function getJson<T>(path: string, validate: (v: unknown) => v is T): Promise<T> {
  const u = url(path);
  const res = await fetch(u);
  if (!res.ok) {
    throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  const body = (await res.json()) as unknown;
  if (!validate(body)) {
    throw new Error(`GET ${u} → malformed response`);
  }
  return body;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown> | undefined,
  validate: (v: unknown) => v is T,
): Promise<T> {
  const u = url(path);
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(u, init);
  if (!res.ok) {
    throw new ApiError(`POST ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  const payload = (await res.json()) as unknown;
  if (!validate(payload)) {
    throw new Error(`POST ${u} → malformed response`);
  }
  return payload;
}

const isAcceptedId = (v: unknown): v is { id: string } =>
  typeof v === "object" && v !== null && typeof (v as { id?: unknown }).id === "string";

// ── URL helpers ─────────────────────────────────────────────────────

export function getRunEventsUrl(id: string, sinceSeq?: number): string {
  // SSE endpoint (text/event-stream). The sibling `/events` route is the
  // since/limit-paginated JSON variant — EventSource pointed at that one
  // got `application/json` back and aborted with a MIME-type mismatch.
  // Pass `sinceSeq` to skip the historical backlog: the server replays
  // every event after that seq, so callers that already have the
  // snapshot data (RunDetail) don't re-process thousands of historical
  // frames on initial connect.
  const base = `/runs/${encodeURIComponent(id)}/stream`;
  return url(typeof sinceSeq === "number" && sinceSeq > 0 ? `${base}?sinceSeq=${sinceSeq}` : base);
}

// ── Endpoints ───────────────────────────────────────────────────────

export async function health(): Promise<HealthResponse> {
  return getJson(
    "/health",
    (v): v is HealthResponse => typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean",
  );
}

export async function listRuns(): Promise<RunSummary[]> {
  return getJson("/runs", (v): v is RunSummary[] => Array.isArray(v) && v.every(isRunSummary));
}

export async function getRun(id: string): Promise<RunDetail> {
  return getJson(`/runs/${encodeURIComponent(id)}`, isRunDetail);
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return getJson("/workflows", (v): v is WorkflowSummary[] => Array.isArray(v) && v.every(isWorkflowSummary));
}

export async function getWorkflow(name: string): Promise<WorkflowDetail> {
  return getJson(`/workflows/${encodeURIComponent(name)}`, isWorkflowDetail);
}

export async function listSkills(opts?: { refresh?: boolean }): Promise<SkillSummary[]> {
  const qs = opts?.refresh ? "?refresh=1" : "";
  return getJson(`/skills${qs}`, (v): v is SkillSummary[] => Array.isArray(v) && v.every(isSkillSummary));
}

export async function getSkill(name: string): Promise<SkillDetail> {
  return getJson(`/skills/${encodeURIComponent(name)}`, isSkillDetail);
}

export async function getRunEvents(id: string): Promise<RunEventsPayload> {
  // The server returns a bare array of StoredEvents (see
  // packages/server/src/store/runs-routes.ts). Older call sites here
  // expected an `{events, lastSeq}` envelope; we adapt on the client so
  // the callers that need `lastSeq` for SSE resume still work, and we
  // don't tie the public REST surface to an envelope format.
  const events = await getJson<unknown[]>(`/runs/${encodeURIComponent(id)}/events.json`, (v): v is unknown[] =>
    Array.isArray(v),
  );
  const last = events[events.length - 1] as { seq?: unknown } | undefined;
  const lastSeq = typeof last?.seq === "number" ? last.seq : 0;
  return { events, lastSeq };
}

export async function getRunSteps(id: string): Promise<StepSnapshot[]> {
  return getJson(
    `/runs/${encodeURIComponent(id)}/steps`,
    (v): v is StepSnapshot[] => Array.isArray(v) && v.every(isStepSnapshot),
  );
}

/** A messages-table row. `content` is a pi-agent-core `AgentMessage`
 * (lossless JSON round-trip). `nodeId` / `iteration` are swarm's
 * projection of which graph node emitted the turn. */
export interface RunMessageRow {
  runId: string;
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
}

export async function getRunMessages(id: string, sinceOrdinal?: number): Promise<RunMessageRow[]> {
  const qs = sinceOrdinal != null && sinceOrdinal > 0 ? `?sinceOrdinal=${sinceOrdinal}` : "";
  return getJson(`/runs/${encodeURIComponent(id)}/messages${qs}`, (v): v is RunMessageRow[] => Array.isArray(v));
}

export async function listJobs(filter?: { status?: JobStatus; limit?: number }): Promise<JobSummary[]> {
  const qs = new URLSearchParams();
  if (filter?.status) qs.set("status", filter.status);
  if (filter?.limit !== undefined) qs.set("limit", String(filter.limit));
  const q = qs.toString();
  return getJson(`/jobs${q ? `?${q}` : ""}`, (v): v is JobSummary[] => Array.isArray(v) && v.every(isJobSummary));
}

export async function getJob(id: string): Promise<JobSummary> {
  return getJson(`/jobs/${encodeURIComponent(id)}`, isJobSummary);
}

export async function cancelJob(id: string): Promise<{ status: string; jobId: string }> {
  const u = url(`/jobs/${encodeURIComponent(id)}`);
  const res = await fetch(u, { method: "DELETE" });
  if (!res.ok) throw new ApiError(`DELETE ${u} → ${res.status} ${res.statusText}`, res.status, u);
  const payload = (await res.json()) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { status?: unknown }).status !== "string" ||
    typeof (payload as { jobId?: unknown }).jobId !== "string"
  ) {
    throw new Error(`DELETE ${u} → malformed response`);
  }
  return payload as { status: string; jobId: string };
}

export async function enqueueJob(input: {
  workflow: string;
  input?: string;
  model?: string;
  priority?: number;
}): Promise<{ jobId: string; runId: string }> {
  const body = {
    workflow: input.workflow,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  };
  return postJson(
    "/jobs",
    body,
    (v): v is { jobId: string; runId: string } =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { jobId?: unknown }).jobId === "string" &&
      typeof (v as { runId?: unknown }).runId === "string",
  );
}

export async function steerRun(id: string, message: string): Promise<{ id: string }> {
  return postJson(`/runs/${encodeURIComponent(id)}/steer`, { message }, isAcceptedId);
}

export async function pauseRun(id: string, reason?: string): Promise<{ id: string }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/runs/${encodeURIComponent(id)}/pause`, body, isAcceptedId);
}

export async function resumeRun(id: string): Promise<{ id: string }> {
  return postJson(`/runs/${encodeURIComponent(id)}/resume`, undefined, isAcceptedId);
}

export async function cancelRun(id: string, reason?: string): Promise<{ id: string }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/runs/${encodeURIComponent(id)}/cancel`, body, isAcceptedId);
}

// ── Providers ────────────────────────────────────────────────────────

export interface ProviderSummary {
  name: string;
  model_count: number;
  credentialed: boolean;
  /** Human label — "auth.json api_key (literal)", "env", "auth.json oauth", etc.
   * Never contains the key itself. */
  auth_source: string | null;
  /** `api_key` / `oauth` when stored in ~/.swarm/auth.json; `null` when
   * sourced from env or a custom models.json provider. */
  auth_kind: "api_key" | "oauth" | null;
  oauth_available: boolean;
  default_model: string | null;
}

export interface ProviderModel {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  baseUrl: string;
}

export interface ProviderDetail extends ProviderSummary {
  models: ProviderModel[];
}

export interface ProvidersListResponse {
  providers: ProviderSummary[];
  models_json_error: string | null;
}

export interface ProviderTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  first_delta_ms?: number | null;
  total_ms?: number;
  output_tokens?: number;
  error?: string;
}

export type ProviderCredentialKind = "literal" | "env" | "shell";

export async function listProviders(): Promise<ProvidersListResponse> {
  return getJson(
    "/providers",
    (v): v is ProvidersListResponse =>
      typeof v === "object" && v !== null && Array.isArray((v as { providers?: unknown }).providers),
  );
}

export async function getProvider(name: string): Promise<ProviderDetail> {
  return getJson(
    `/providers/${encodeURIComponent(name)}`,
    (v): v is ProviderDetail =>
      typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string",
  );
}

export async function testProvider(name: string, model?: string): Promise<ProviderTestResult> {
  const body = model !== undefined ? { model } : undefined;
  return postJson(
    `/providers/${encodeURIComponent(name)}/test`,
    body,
    (v): v is ProviderTestResult =>
      typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean",
  );
}

export async function setProviderCredentials(
  name: string,
  kind: ProviderCredentialKind,
  value: string,
): Promise<{ ok: boolean }> {
  return postJson(
    `/providers/${encodeURIComponent(name)}/credentials`,
    { kind, value },
    (v): v is { ok: boolean } => typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean",
  );
}

export async function removeProviderCredentials(name: string): Promise<{ ok: boolean; removed: boolean }> {
  const u = url(`/providers/${encodeURIComponent(name)}/credentials`);
  const res = await fetch(u, { method: "DELETE" });
  if (!res.ok) throw new ApiError(`DELETE ${u} → ${res.status} ${res.statusText}`, res.status, u);
  const body = (await res.json()) as { ok?: unknown; removed?: unknown };
  if (typeof body.ok !== "boolean") throw new Error(`DELETE ${u} → malformed response`);
  return { ok: body.ok, removed: typeof body.removed === "boolean" ? body.removed : false };
}

// ── Shape validators ────────────────────────────────────────────────
// Soft-validate metric fields: older server builds may omit them. Rejecting
// those payloads would break dev UX against mixed versions. Validators
// require identity/status and coerce missing metrics to zero downstream.

function isRunSummary(v: unknown): v is RunSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    runId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    eventCount?: unknown;
    costUsd?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
    durationMs?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.eventCount === "number" &&
    (o.costUsd === undefined || typeof o.costUsd === "number") &&
    (o.inputTokens === undefined || typeof o.inputTokens === "number") &&
    (o.outputTokens === undefined || typeof o.outputTokens === "number") &&
    (o.cacheReadTokens === undefined || typeof o.cacheReadTokens === "number") &&
    (o.cacheWriteTokens === undefined || typeof o.cacheWriteTokens === "number") &&
    (o.durationMs === undefined || typeof o.durationMs === "number")
  );
}

function isRunDetail(v: unknown): v is RunDetail {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    runId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    lastEventSeq?: unknown;
    nodes?: unknown;
    selectedEdges?: unknown;
    workflowSource?: unknown;
    costUsd?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
    durationMs?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.lastEventSeq === "number" &&
    Array.isArray(o.nodes) &&
    Array.isArray(o.selectedEdges) &&
    (o.workflowSource === undefined || typeof o.workflowSource === "string") &&
    (o.costUsd === undefined || typeof o.costUsd === "number") &&
    (o.inputTokens === undefined || typeof o.inputTokens === "number") &&
    (o.outputTokens === undefined || typeof o.outputTokens === "number") &&
    (o.cacheReadTokens === undefined || typeof o.cacheReadTokens === "number") &&
    (o.cacheWriteTokens === undefined || typeof o.cacheWriteTokens === "number") &&
    (o.durationMs === undefined || typeof o.durationMs === "number")
  );
}

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

function isWorkflowDetail(v: unknown): v is WorkflowDetail {
  if (!isWorkflowSummary(v)) return false;
  return typeof (v as { source?: unknown }).source === "string";
}

function isJobStatus(v: unknown): v is JobStatus {
  return v === "queued" || v === "running" || v === "success" || v === "failed" || v === "canceled";
}

function isJobSummary(v: unknown): v is JobSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as {
    id?: unknown;
    runId?: unknown;
    workflow?: unknown;
    status?: unknown;
    priority?: unknown;
    enqueuedAt?: unknown;
  };
  return (
    typeof o.id === "string" &&
    typeof o.runId === "string" &&
    typeof o.workflow === "string" &&
    isJobStatus(o.status) &&
    typeof o.priority === "number" &&
    typeof o.enqueuedAt === "string"
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
