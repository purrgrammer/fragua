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

import type { AgentMessage, FeedEvent } from "@swarm/types";
import type { AnalyticsPayload, AnalyticsRunsPage, BucketKind } from "../types/analytics.ts";

export type { FeedEvent };

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
  /** Raw lifecycle status from the store. Used by Inbox and other
   * fine-grained filters that need to distinguish e.g. `paused_hitl`
   * from `paused`. The coarse `status` above is what the badge
   * renders. Optional because older server builds may omit it —
   * mirrors the soft-validate pattern below. */
  runStatus?:
    | "queued"
    | "running"
    | "paused"
    | "paused_hitl"
    | "paused_provider_retry"
    | "paused_retry"
    | "completed"
    | "cancelled"
    | "halted"
    | "quarantined";
  eventCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  title?: string;
  input?: string;
  /** Project root the run was enqueued from. Mirrors `run_state.cwd`.
   * Absent for ephemeral runs (CI primitives, tests). */
  cwd?: string;
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
  /** Raw lifecycle status from the store. Used by Inbox and other
   * fine-grained filters that need to distinguish e.g. `paused_hitl`
   * from `paused`. The coarse `status` above is what the badge
   * renders. Optional because older server builds may omit it —
   * mirrors the soft-validate pattern below. */
  runStatus?:
    | "queued"
    | "running"
    | "paused"
    | "paused_hitl"
    | "paused_provider_retry"
    | "paused_retry"
    | "completed"
    | "cancelled"
    | "halted"
    | "quarantined";
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
  hitlNodeId?: string;
  hitlLabel?: string;
  hitlOptions?: Array<{ key: string; label: string; to: string }>;
  /** Project root the run was enqueued from. Mirrors `run_state.cwd`.
   * Absent for ephemeral runs (CI primitives, tests). */
  cwd?: string;
  /** Absolute path to the still-mounted worktree under
   * `<cwd>/.swarm/worktrees/<runId>`. Absent once the worktree was
   * disposed or for runs that never had one. */
  worktreePath?: string;
}

/** One row in `GET /runs/:runId/changes`. Server projects
 *  `git diff --numstat` + `--name-status` between the run's
 *  `baseGitSha` and the tip of `swarm/runs/<runId>`. */
export interface RunChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
  /** Project root that owns this workflow. `undefined` means the global
   *  source (`~/.swarm/workflows/`); a string is the absolute cwd of a
   *  project shown by `/projects`. Names may collide across sources, so
   *  the listing surface must show the cwd to disambiguate and the
   *  detail link must thread `?cwd=` through. */
  cwd?: string;
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

/**
 * Per-LLM-call snapshot, shaped for `CostInspector`.
 *
 * Bodies (prompt, system prompt, prior messages, final text, tools,
 * context files, skills, settings, budget) are intentionally NOT here —
 * that content lives in the Conversation tab and the messages table.
 * Shipping it again on this endpoint doubled the wire payload, and
 * `messages` (the prior conversation per step) accumulated O(N²)
 * tool-result content for nothing the UI ever read.
 */
export interface StepSnapshot {
  stepIdx: number;
  /** Stream seq of the originating `llm.start`. Joins this snapshot to
   * the SQL cost-aggregate row produced by the server. Stable React key. */
  startSeq: number;
  nodeId: string;
  iteration?: { n: number; max: number };
  /** ISO timestamp of the originating `llm.start`. The UI ticks
   * `now - startedAt` for in-flight steps before `durationMs` lands. */
  startedAt: string;
  /** Set when the step's last `llm.done` has fired. Absent while the
   * step is still in flight; the UI computes elapsed live. */
  durationMs?: number;
  provider?: string;
  model?: string;
  fidelity?: string;
  /** Set when this step ran as a branch of a parallel/component fan-out:
   * the parent component's nodeId. Drives the indented child rows under
   * the parent in CostInspector. */
  parentNodeId?: string;
  /** Branch index within the parallel parent's `children` list. */
  parallelIndex?: number;
  cost?: {
    input_tokens: number;
    output_tokens: number;
    billed_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
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

/** Server response shape from `appendIntent` — every `/runs/:id/*`
 * intent endpoint (steer, pause, resume, cancel, hitl, unquarantine,
 * priority) returns `{ seq }`, the per-run sequence number of the
 * persisted intent event. */
const isAcceptedSeq = (v: unknown): v is { seq: number } =>
  typeof v === "object" && v !== null && typeof (v as { seq?: unknown }).seq === "number";

// ── URL helpers ─────────────────────────────────────────────────────

/** Loose runtime shape check for a `FeedEvent`. The full discriminated
 * union (`@swarm/types` `FeedEvent`) is enforced at the type layer;
 * over the wire we only validate the envelope columns are present and
 * trust the server-side allow-list to keep `type` to a known kind. */
const isFeedEvent = (v: unknown): v is FeedEvent =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { runId?: unknown }).runId === "string" &&
  typeof (v as { seq?: unknown }).seq === "number" &&
  typeof (v as { type?: unknown }).type === "string" &&
  typeof (v as { ts?: unknown }).ts === "number";

/** Backfill: most-recent N allow-listed events, oldest-first. */
export async function getFeedEvents(limit?: number): Promise<FeedEvent[]> {
  const qs = typeof limit === "number" ? `?limit=${limit}` : "";
  return getJson(`/events${qs}`, (v): v is FeedEvent[] => Array.isArray(v) && v.every(isFeedEvent));
}

/** SSE URL for the live global feed. `fromTs` is inclusive — the server
 * uses `ts >= fromTs` and the client dedupes the bounded redelivery at
 * the boundary. Pass the max ts of the backfill to start from. */
export function getFeedStreamUrl(fromTs?: number): string {
  const base = "/events/stream";
  return url(typeof fromTs === "number" && fromTs > 0 ? `${base}?fromTs=${fromTs}` : base);
}

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

/** Filter passed to `GET /runs`. Every field is enforced server-side
 * (filter, order, limit). The web does no client-side sort or slice. */
export interface ListRunsFilter {
  status?: ReadonlyArray<NonNullable<RunSummary["runStatus"]>>;
  /** `"oldest"` surfaces longest-waiting runs first (Inbox metaphor).
   * Default = newest-first by updated_at. */
  order?: "newest" | "oldest";
  /** SQL `LIMIT`. Server clamps to a sane max. */
  limit?: number;
  /** Narrow to a single project root (exact `run_state.cwd` match). */
  cwd?: string;
}

export async function listRuns(filter?: ListRunsFilter): Promise<RunSummary[]> {
  const params = new URLSearchParams();
  if (filter?.status && filter.status.length > 0) {
    // Sort so the same logical filter always produces the same URL.
    params.set("status", [...filter.status].sort().join(","));
  }
  if (filter?.order && filter.order !== "newest") params.set("order", filter.order);
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter?.cwd !== undefined && filter.cwd.length > 0) params.set("cwd", filter.cwd);
  const qs = params.toString();
  const path = qs ? `/runs?${qs}` : "/runs";
  return getJson(path, (v): v is RunSummary[] => Array.isArray(v) && v.every(isRunSummary));
}

/** Project = distinct `run_state.cwd`. `name` is `basename(cwd)` (server
 * computes it so paths with mixed separators don't drift across clients).
 * The wire identity is `cwd`. */
export interface ProjectSummary {
  cwd: string;
  name: string;
  lastUpdatedAt: number;
  runCount: number;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return getJson("/projects", (v): v is ProjectSummary[] => Array.isArray(v) && v.every(isProjectSummary));
}

/** One row in `GET /projects/:id/tree`. The list is flat — every file
 *  plus every ancestor directory it implies — so the web folds the
 *  nested shape `<FileTree>` wants client-side. */
export interface ProjectTreeEntry {
  path: string;
  type: "file" | "dir";
}

export async function getProjectTree(projectId: string): Promise<ProjectTreeEntry[]> {
  return getJson(
    `/projects/${encodeURIComponent(projectId)}/tree`,
    (v): v is ProjectTreeEntry[] => Array.isArray(v) && v.every(isProjectTreeEntry),
  );
}

/** Fetch one file's contents as utf-8 text. Throws `ApiError` on any
 *  non-2xx — callers branch on `.status` so a 413 / 415 can render the
 *  right "too large" / "binary" affordance instead of a generic empty
 *  state. */
export async function getProjectBlob(projectId: string, path: string): Promise<string> {
  const u = url(`/projects/${encodeURIComponent(projectId)}/blob?path=${encodeURIComponent(path)}`);
  const res = await fetch(u);
  if (!res.ok) {
    throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  return res.text();
}

/** GET /runs/:runId/tree → flat ProjectTreeEntry[] under the run's
 *  worktree. Throws ApiError; callers branch on `.status === 410` to
 *  treat the worktree as disposed (still show the changes panel). */
export async function getRunTree(runId: string): Promise<ProjectTreeEntry[]> {
  return getJson(
    `/runs/${encodeURIComponent(runId)}/tree`,
    (v): v is ProjectTreeEntry[] => Array.isArray(v) && v.every(isProjectTreeEntry),
  );
}

export async function getRunBlob(runId: string, path: string): Promise<string> {
  const u = url(`/runs/${encodeURIComponent(runId)}/blob?path=${encodeURIComponent(path)}`);
  const res = await fetch(u);
  if (!res.ok) {
    throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  return res.text();
}

export async function getRunDiff(runId: string): Promise<string> {
  const u = url(`/runs/${encodeURIComponent(runId)}/diff`);
  const res = await fetch(u);
  if (!res.ok) {
    throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  return res.text();
}

export async function getRunChanges(runId: string): Promise<RunChange[]> {
  return getJson(
    `/runs/${encodeURIComponent(runId)}/changes`,
    (v): v is RunChange[] => Array.isArray(v) && v.every(isRunChange),
  );
}

export async function getRun(id: string): Promise<RunDetail> {
  return getJson(`/runs/${encodeURIComponent(id)}`, isRunDetail);
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  return getJson("/workflows", (v): v is WorkflowSummary[] => Array.isArray(v) && v.every(isWorkflowSummary));
}

export async function getWorkflow(name: string, opts?: { cwd?: string }): Promise<WorkflowDetail> {
  // `cwd` is forwarded as a query string — empty string is meaningful
  // (pin to the global source) and must round-trip, so we encode it
  // explicitly rather than skipping when falsy.
  const qs = opts?.cwd !== undefined ? `?cwd=${encodeURIComponent(opts.cwd)}` : "";
  return getJson(`/workflows/${encodeURIComponent(name)}${qs}`, isWorkflowDetail);
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
 * (lossless JSON round-trip). `nodeId` is swarm's projection of which
 * graph node emitted the turn.
 *
 * `runId` and `iteration` are intentionally absent from the wire shape:
 * the URL already pins `runId`, and `iteration` is unused by the UI. */
export interface RunMessageRow {
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
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

/** Direct POST /runs — bypasses /jobs. The workflow must already be
 * registered (its sha is what GET /workflows returns), so the composer
 * doesn't re-upload DOT source. `cwd` lands on `run_state.cwd` and is
 * how the project filter on /projects/:id resolves the run later. */
export interface CreateRunInput {
  workflowSha: string;
  workflowName?: string;
  workflowScope?: "global" | "local" | "path" | "ephemeral";
  workflowPath?: string;
  cwd?: string;
  input?: string;
  priority?: number;
}

export async function createRun(args: CreateRunInput): Promise<{ runId: string }> {
  const body: Record<string, unknown> = { workflowSha: args.workflowSha };
  if (args.workflowName !== undefined) body["workflowName"] = args.workflowName;
  if (args.workflowScope !== undefined) body["workflowScope"] = args.workflowScope;
  if (args.workflowPath !== undefined) body["workflowPath"] = args.workflowPath;
  if (args.cwd !== undefined) body["cwd"] = args.cwd;
  if (args.input !== undefined) body["input"] = args.input;
  if (args.priority !== undefined) body["priority"] = args.priority;
  return postJson(
    "/runs",
    body,
    (v): v is { runId: string } =>
      typeof v === "object" && v !== null && typeof (v as { runId?: unknown }).runId === "string",
  );
}

export async function steerRun(id: string, message: string): Promise<{ seq: number }> {
  return postJson(`/runs/${encodeURIComponent(id)}/steer`, { text: message }, isAcceptedSeq);
}

export async function submitHitlChoice(runId: string, selected: string, note?: string): Promise<{ seq: number }> {
  const body: { selected: string; note?: string } = { selected };
  if (note) body.note = note;
  return postJson(`/runs/${encodeURIComponent(runId)}/hitl`, body, isAcceptedSeq);
}

export async function pauseRun(id: string, reason?: string): Promise<{ seq: number }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/runs/${encodeURIComponent(id)}/pause`, body, isAcceptedSeq);
}

export async function resumeRun(id: string): Promise<{ seq: number }> {
  return postJson(`/runs/${encodeURIComponent(id)}/resume`, undefined, isAcceptedSeq);
}

export async function cancelRun(id: string, reason?: string): Promise<{ seq: number }> {
  const body = reason !== undefined ? { reason } : undefined;
  return postJson(`/runs/${encodeURIComponent(id)}/cancel`, body, isAcceptedSeq);
}

/** Operator raises a budget ceiling on a `paused{reason:"budget"}` run.
 *  Caller typically follows with `resumeRun(id)` to bundle "Raise & Resume"
 *  into one click — the protocol keeps the two intents separate so
 *  `intent.resume` stays naked across all pause reasons. */
export async function adjustBudget(
  id: string,
  scope: "node" | "run",
  metric: "cost" | "tokens",
  newLimit: number,
  note?: string,
): Promise<{ seq: number }> {
  const body: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number; note?: string } = {
    scope,
    metric,
    newLimit,
  };
  if (note !== undefined) body.note = note;
  return postJson(`/runs/${encodeURIComponent(id)}/budget`, body, isAcceptedSeq);
}

// ── Analytics ────────────────────────────────────────────────────────

export interface AnalyticsRequest {
  fromMs: number;
  toMs: number;
  bucket: BucketKind;
  tzOffsetMinutes: number;
  compareFromMs?: number | null;
  compareToMs?: number | null;
  /** Optional project filter — exact `run_state.cwd` match. Absent =
   *  every project. The query-key includes this field so toggling the
   *  project selector re-fetches without a stale-cache flash. */
  cwd?: string;
}

export async function getAnalytics(req: AnalyticsRequest): Promise<AnalyticsPayload> {
  const params = new URLSearchParams({
    from: String(req.fromMs),
    to: String(req.toMs),
    bucket: req.bucket,
    tzOffsetMinutes: String(req.tzOffsetMinutes),
  });
  if (req.compareFromMs != null && req.compareToMs != null) {
    params.set("compareFrom", String(req.compareFromMs));
    params.set("compareTo", String(req.compareToMs));
  }
  if (req.cwd) params.set("cwd", req.cwd);
  return getJson(`/analytics?${params.toString()}`, isAnalyticsPayload);
}

export interface AnalyticsRunsRequest {
  fromMs: number;
  toMs: number;
  workflowSha?: string | undefined;
  haltCategory?: string | undefined;
  model?: string | undefined;
  /** Same shape + semantics as `AnalyticsRequest.cwd`; lets the
   *  drill-down drawer stay scoped to the project the user picked. */
  cwd?: string | undefined;
  limit?: number;
  cursor?: string | null | undefined;
}

export async function getAnalyticsRuns(req: AnalyticsRunsRequest): Promise<AnalyticsRunsPage> {
  const params = new URLSearchParams({
    from: String(req.fromMs),
    to: String(req.toMs),
  });
  if (req.workflowSha) params.set("workflow", req.workflowSha);
  if (req.haltCategory) params.set("halt", req.haltCategory);
  if (req.model) params.set("model", req.model);
  if (req.cwd) params.set("cwd", req.cwd);
  if (req.limit !== undefined) params.set("limit", String(req.limit));
  if (req.cursor) params.set("cursor", req.cursor);
  return getJson(`/analytics/runs?${params.toString()}`, isAnalyticsRunsPage);
}

function isAnalyticsPayload(v: unknown): v is AnalyticsPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["window"] === "object" &&
    typeof o["totals"] === "object" &&
    Array.isArray(o["runsByBucket"]) &&
    Array.isArray(o["spendByBucket"]) &&
    Array.isArray(o["tokensByBucket"]) &&
    Array.isArray(o["cacheByBucket"]) &&
    Array.isArray(o["haltDistribution"]) &&
    Array.isArray(o["modelDistribution"]) &&
    Array.isArray(o["topWorkflows"])
  );
}

function isAnalyticsRunsPage(v: unknown): v is AnalyticsRunsPage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o["runs"]) && (o["nextCursor"] === null || typeof o["nextCursor"] === "string");
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
    cwd?: unknown;
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
    (o.durationMs === undefined || typeof o.durationMs === "number") &&
    (o.cwd === undefined || typeof o.cwd === "string")
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
    cwd?: unknown;
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
    (o.durationMs === undefined || typeof o.durationMs === "number") &&
    (o.cwd === undefined || typeof o.cwd === "string") &&
    ((o as { worktreePath?: unknown }).worktreePath === undefined ||
      typeof (o as { worktreePath?: unknown }).worktreePath === "string")
  );
}

function isRunChange(v: unknown): v is RunChange {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { path?: unknown; status?: unknown; additions?: unknown; deletions?: unknown };
  return (
    typeof o.path === "string" &&
    (o.status === "added" || o.status === "modified" || o.status === "deleted" || o.status === "renamed") &&
    typeof o.additions === "number" &&
    typeof o.deletions === "number"
  );
}

function isProjectTreeEntry(v: unknown): v is ProjectTreeEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { path?: unknown; type?: unknown };
  return typeof o.path === "string" && (o.type === "file" || o.type === "dir");
}

function isProjectSummary(v: unknown): v is ProjectSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { cwd?: unknown; name?: unknown; lastUpdatedAt?: unknown; runCount?: unknown };
  return (
    typeof o.cwd === "string" &&
    typeof o.name === "string" &&
    typeof o.lastUpdatedAt === "number" &&
    typeof o.runCount === "number"
  );
}

function isWorkflowSummary(v: unknown): v is WorkflowSummary {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { name?: unknown; path?: unknown; sha?: unknown; label?: unknown; cwd?: unknown };
  return (
    typeof o.name === "string" &&
    typeof o.path === "string" &&
    typeof o.sha === "string" &&
    (o.label === undefined || typeof o.label === "string") &&
    (o.cwd === undefined || typeof o.cwd === "string")
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
    startSeq?: unknown;
    nodeId?: unknown;
    startedAt?: unknown;
  };
  return (
    typeof o.stepIdx === "number" &&
    typeof o.startSeq === "number" &&
    typeof o.nodeId === "string" &&
    typeof o.startedAt === "string"
  );
}
