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

export interface PipelineSummary {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "running" | "success" | "fail" | "canceled" | "unknown";
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
 * `workflowSource` is the raw DOT captured on `pipeline.started`; absent
 * when the run predates source capture. There is intentionally NO
 * `edges` field — topology lives in the DOT source and is parsed
 * client-side by `@swarm/core`'s `parseDotSource` so the server isn't a
 * second parser.
 */
export interface PipelineDetail {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "running" | "success" | "fail" | "canceled" | "unknown";
  lastEventSeq: number;
  nodes: NodeState[];
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

export interface PipelineEventsPayload {
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

export function getPipelineEventsUrl(id: string): string {
  return url(`/pipelines/${encodeURIComponent(id)}/events`);
}

// ── Endpoints ───────────────────────────────────────────────────────

export async function health(): Promise<HealthResponse> {
  return getJson(
    "/health",
    (v): v is HealthResponse => typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean",
  );
}

export async function listPipelines(): Promise<PipelineSummary[]> {
  return getJson("/pipelines", (v): v is PipelineSummary[] => Array.isArray(v) && v.every(isPipelineSummary));
}

export async function getPipeline(id: string): Promise<PipelineDetail> {
  return getJson(`/pipelines/${encodeURIComponent(id)}`, isPipelineDetail);
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

export async function getPipelineEvents(id: string): Promise<PipelineEventsPayload> {
  return getJson(
    `/pipelines/${encodeURIComponent(id)}/events.json`,
    (v): v is PipelineEventsPayload =>
      typeof v === "object" &&
      v !== null &&
      Array.isArray((v as { events?: unknown }).events) &&
      typeof (v as { lastSeq?: unknown }).lastSeq === "number",
  );
}

export async function getPipelineSteps(id: string): Promise<StepSnapshot[]> {
  return getJson(
    `/pipelines/${encodeURIComponent(id)}/steps`,
    (v): v is StepSnapshot[] => Array.isArray(v) && v.every(isStepSnapshot),
  );
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
  return postJson(`/pipelines/${encodeURIComponent(id)}/steer`, { message }, isAcceptedId);
}

export async function pauseRun(id: string, reason?: string): Promise<{ id: string }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/pipelines/${encodeURIComponent(id)}/pause`, body, isAcceptedId);
}

export async function resumeRun(id: string): Promise<{ id: string }> {
  return postJson(`/pipelines/${encodeURIComponent(id)}/resume`, undefined, isAcceptedId);
}

export async function cancelRun(id: string, reason?: string): Promise<{ id: string }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/pipelines/${encodeURIComponent(id)}/cancel`, body, isAcceptedId);
}

// ── Shape validators ────────────────────────────────────────────────
// Soft-validate metric fields: older server builds may omit them. Rejecting
// those payloads would break dev UX against mixed versions. Validators
// require identity/status and coerce missing metrics to zero downstream.

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
