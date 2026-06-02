// Thin fetch client for the @fragua/server REST surface.
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

import type { AgentMessage, FeedEvent, SnapshotStat } from "@fragua/types";
import type { AnalyticsPayload, AnalyticsRunsPage, BucketKind } from "../types/analytics.ts";

export type { FeedEvent };

export const BASE_URL = "/api";

export interface HealthResponse {
  ok: boolean;
  /**
   * Present when the server runs as the fragua daemon (exposes a job
   * queue + process supervisor). Absent for plain `fragua serve`, which
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
   * fine-grained filters that need to distinguish e.g. `paused_human`
   * from `paused`. The coarse `status` above is what the badge
   * renders. Optional because older server builds may omit it —
   * mirrors the soft-validate pattern below. */
  runStatus?:
    | "queued"
    | "running"
    | "paused"
    | "paused_human"
    | "paused_auto"
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
  /** Project IDENTITY (UUIDv7). Stable across machines/checkouts; URL-safe.
   * The wire key for `?project_id=` and `/projects/:id`. Optional only to
   * tolerate older/ephemeral payloads — present on every daemon run. */
  projectId?: string;
  /** Project display label captured at enqueue. */
  projectName?: string;
  /** Local checkout the run was enqueued from. Mirrors `run_state.cwd`.
   * A per-machine LOCATION hint, not identity. Absent for ephemeral runs. */
  cwd?: string;
  /** Worktree inbox status. `pending` = a terminal run with recoverable
   * work awaiting an operator primitive. Absent on non-worktree runs. */
  inboxStatus?: "pending" | "acted" | "discarded";
  /** Terminal diff stat — committed (workflow commits) vs uncommitted
   * (agent dirt); either side null. Drives the inbox row's change badge. */
  changeStat?: {
    committed: SnapshotChangeStat | null;
    uncommitted: SnapshotChangeStat | null;
  };
  /** Source repo branch + HEAD sha at provision — operator-action target
   * default + git-centric row/feed label. Absent when provisioned detached. */
  baseGitRef?: string;
  baseGitSha?: string;
}

export interface NodeState {
  nodeId: string;
  /** Loop iteration this entry describes (0 for the first dispatch, 1 for
   * the first re-entry across a backward edge or goal-gate retarget, …). A
   * non-looping run carries only `iteration: 0` entries; the graph view
   * groups by `nodeId` and renders the latest iteration's state. */
  iteration: number;
  state: "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";
  lastEventSeq: number;
}

/**
 * `workflowSource` is the raw workflow captured on `run.started`; absent
 * when the run predates source capture. There is intentionally NO
 * `edges` field — topology lives in the workflow source and is parsed
 * client-side by `@fragua/core`'s `parseWorkflow` so the server isn't a
 * second parser.
 */
/** `(from, to, iteration)` triple for an edge the executor traversed — see
 *  server's `SelectedEdge` schema. Ordered log. Multiple entries for the
 *  same `(from, to)` carry distinct `iteration`s (back-edge re-traversal). */
export interface SelectedEdge {
  from: string;
  to: string;
  iteration: number;
}

export interface RunDetail {
  runId: string;
  workflow?: string;
  workflowName?: string;
  startedAt: string;
  status: "queued" | "running" | "paused" | "success" | "fail" | "canceled" | "unknown";
  /** Raw lifecycle status from the store. Used by Inbox and other
   * fine-grained filters that need to distinguish e.g. `paused_human`
   * from `paused`. The coarse `status` above is what the badge
   * renders. Optional because older server builds may omit it —
   * mirrors the soft-validate pattern below. */
  runStatus?:
    | "queued"
    | "running"
    | "paused"
    | "paused_human"
    | "paused_auto"
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
  hitlNodeId?: string;
  hitlLabel?: string;
  /** Declared route names from the paused human node's `routes=` attr;
   *  one button rendered per route. */
  hitlOptions?: string[];
  /** Sparse route-name → button-text map from each outgoing edge's `label=`
   *  override (D6). Routes absent here fall back to `humanizeRouteName`. */
  hitlOptionLabels?: Record<string, string>;
  /** Per-node record of the route (and optional note) the operator chose at
   *  each answered human gate, derived from `intent.human_input`. Survives
   *  resume so a running/terminal run still shows past decisions. */
  hitlDecisions?: Record<string, { route: string; note?: string }>;
  /** Project IDENTITY (UUIDv7). Stable across machines/checkouts; URL-safe.
   * The wire key for `?project_id=` and `/projects/:id`. Optional only to
   * tolerate older/ephemeral payloads — present on every daemon run. */
  projectId?: string;
  /** Project display label captured at enqueue. */
  projectName?: string;
  /** Local checkout the run was enqueued from. Mirrors `run_state.cwd`.
   * A per-machine LOCATION hint, not identity. Absent for ephemeral runs. */
  cwd?: string;
  /** Absolute path to the still-mounted worktree under
   * `<cwd>/.fragua/worktrees/<runId>`. Absent once the worktree was
   * disposed or for runs that never had one. */
  worktreePath?: string;
  /** Source repo branch + HEAD sha at provision — shown in run-detail git
   * metadata and used as the operator-action target default. */
  baseGitRef?: string;
  baseGitSha?: string;
  /** True when the run was brought in via `fragua import`. The run has no
   * local cwd, the daemon will never dispatch it, and operate controls
   * should be suppressed. */
  imported?: boolean;
}

/** One row in `GET /runs/:runId/changes`. Server projects
 *  `git diff --numstat` + `--name-status` between the run's
 *  `baseGitSha` and the tip of `fragua/runs/<runId>`. */
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
   *  source (`~/.fragua/workflows/`); a string is the absolute cwd of a
   *  project shown by `/projects`. Names may collide across sources, so
   *  the listing surface must show the cwd to disambiguate and the
   *  detail link must thread `?cwd=` through. */
  cwd?: string;
}

/** A typed input declaration from a workflow's `inputs:` block. Mirrors
 *  `InputDecl` from `@fragua/core` — kept local so the web bundle doesn't
 *  import the core package directly. */
export interface WorkflowInputDecl {
  name: string;
  type: "string" | "boolean" | "number" | "choice";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

/** Full workflow, including the raw workflow source. Fetched on demand by
 *  the workflow detail page — the list endpoint stays cheap. The source is
 *  parsed client-side by `@fragua/core`'s `parseWorkflow`; the server
 *  never parses the source itself. */
export interface WorkflowDetail extends WorkflowSummary {
  source: string;
  /** Parsed `inputs:` declarations from the workflow. Absent when the
   *  workflow declares no inputs or when talking to an older server
   *  that does not emit the field. */
  inputs?: WorkflowInputDecl[];
}

export interface SkillSummary {
  /** base64url(skill_dir) — opaque URL-safe handle. Names aren't unique
   * across projects (project A and project B can both have `frontend`),
   * so the absolute path is the canonical identity. */
  locId: string;
  name: string;
  description: string;
  version?: string;
  allowed_tools?: string[];
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  location: string;
  skill_dir: string;
  sha256: string;
  bytes: number;
  scope: "project" | "user";
  source_dir: string;
  /** Set only when `scope === "project"`. */
  project_cwd?: string;
  disabled_reason?: string;
}

export interface SkillDetail {
  skill: SkillSummary;
  /** YAML frontmatter from SKILL.md, parsed into a flat object. */
  frontmatter: Record<string, unknown>;
  /** SKILL.md body, frontmatter stripped, leading/trailing whitespace trimmed. */
  body: string;
}

export interface SkillTreeEntry {
  /** Path relative to skill_dir, posix-separated. */
  path: string;
  type: "file" | "dir";
  /** Bytes for files, 0 for dirs. */
  size: number;
}

export interface SkillTreeResponse {
  tree: SkillTreeEntry[];
  truncated: boolean;
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
  summary?: string;
  cost?: {
    input_tokens: number;
    output_tokens: number;
    billed_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
  /** Set client-side by CostInspector.mergeStepsByNode when this row
   * collapses multiple `llm.start` windows for the same node
   * (multi-turn llm, pause+resume cycles). Surfaces as a small
   * "× N turns" badge so the operator knows the row is a sum. */
  turns?: number;
}

/** Thrown for any non-2xx HTTP response. Callers can branch on `.status`
 *  to render status-specific fallbacks (e.g. 404 → empty state).
 *  For 4xx refusals from the worktree-inbox action endpoints the server
 *  returns `{ error: string; code: string }` — that body is parsed and
 *  attached as `.body` so callers can read the machine-readable `code`. */
export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  /** Parsed response body, when the server returned JSON. Present on
   *  4xx refusals from intent endpoints; `undefined` elsewhere. */
  readonly body?: { error?: string; code?: string };
  constructor(message: string, status: number, url: string, body?: { error?: string; code?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
    this.body = body;
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
    let refusalBody: { error?: string; code?: string } | undefined;
    try {
      refusalBody = (await res.json()) as { error?: string; code?: string };
    } catch {
      // non-JSON error body — leave refusalBody undefined
    }
    throw new ApiError(`POST ${u} → ${res.status} ${res.statusText}`, res.status, u, refusalBody);
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
 * union (`@fragua/types` `FeedEvent`) is enforced at the type layer;
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
  /** Narrow to a project by IDENTITY (`run_state.project_id`). Portable
   *  across checkouts; folds clones/imports of the same repo. */
  projectId?: string;
  /** Narrow to a single project LOCATION (exact `run_state.cwd` match). */
  cwd?: string;
  /** Filter by worktree inbox status.
   * `"pending"` surfaces terminal runs awaiting an operator primitive. */
  inbox?: "pending" | "acted" | "discarded";
}

export async function listRuns(filter?: ListRunsFilter): Promise<RunSummary[]> {
  const params = new URLSearchParams();
  if (filter?.status && filter.status.length > 0) {
    // Sort so the same logical filter always produces the same URL.
    params.set("status", [...filter.status].sort().join(","));
  }
  if (filter?.order && filter.order !== "newest") params.set("order", filter.order);
  if (filter?.limit !== undefined) params.set("limit", String(filter.limit));
  if (filter?.projectId !== undefined && filter.projectId.length > 0) params.set("project_id", filter.projectId);
  if (filter?.cwd !== undefined && filter.cwd.length > 0) params.set("cwd", filter.cwd);
  if (filter?.inbox !== undefined) params.set("inbox", filter.inbox);
  const qs = params.toString();
  const path = qs ? `/runs?${qs}` : "/runs";
  return getJson(path, (v): v is RunSummary[] => Array.isArray(v) && v.every(isRunSummary));
}

/** Project = distinct `run_state.project_id` (IDENTITY). `projectId` is the
 * stable, URL-safe wire identity (UUIDv7) that folds clones/imports of the
 * same repo. `cwd`/`cwdHint` is a per-machine LOCATION hint (the most-recent
 * local checkout); either is null for an imported-only project. */
export interface ProjectSummary {
  projectId: string;
  name: string;
  cwd: string | null;
  cwdHint: string | null;
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

/** Change-stat shape for a snapshot's committed or uncommitted deltas —
 *  the canonical server shape (`@fragua/types` SnapshotStat), not a web-local
 *  re-spelling. The `/runs/:id/snapshots` payload uses these exact keys. */
export type SnapshotChangeStat = SnapshotStat;

/** One entry from `GET /runs/:id/snapshots`. */
export interface RunSnapshot {
  eventIdx: number;
  nodeId: string | null;
  label: "step" | "hitl" | "terminal";
  commitSha: string;
  treeSha: string;
  committed: SnapshotChangeStat | null;
  uncommitted: SnapshotChangeStat | null;
}

function isSnapshotChangeStat(v: unknown): v is SnapshotChangeStat {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["filesChanged"] === "number" && typeof s["insertions"] === "number" && typeof s["deletions"] === "number"
  );
}

function isRunSnapshot(v: unknown): v is RunSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s["eventIdx"] === "number" &&
    (s["nodeId"] === null || typeof s["nodeId"] === "string") &&
    (s["label"] === "step" || s["label"] === "hitl" || s["label"] === "terminal") &&
    typeof s["commitSha"] === "string" &&
    typeof s["treeSha"] === "string" &&
    (s["committed"] === null || isSnapshotChangeStat(s["committed"])) &&
    (s["uncommitted"] === null || isSnapshotChangeStat(s["uncommitted"]))
  );
}

export async function listRunSnapshots(runId: string): Promise<RunSnapshot[]> {
  return getJson(
    `/runs/${encodeURIComponent(runId)}/snapshots`,
    (v): v is RunSnapshot[] => Array.isArray(v) && v.every(isRunSnapshot),
  );
}

export async function getRunSnapshotDiff(
  runId: string,
  eventIdx: number,
  opts?: { against?: string; path?: string },
): Promise<string> {
  const params = new URLSearchParams();
  if (opts?.against) params.set("against", opts.against);
  if (opts?.path) params.set("path", opts.path);
  const qs = params.toString();
  const u = url(
    `/runs/${encodeURIComponent(runId)}/snapshots/${encodeURIComponent(String(eventIdx))}/diff${qs ? `?${qs}` : ""}`,
  );
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

function buildScopedListQs(opts?: { projectCwd?: string; projectOnly?: boolean }): string {
  if (opts?.projectCwd === undefined) return "";
  const parts = [`project_cwd=${encodeURIComponent(opts.projectCwd)}`];
  if (opts.projectOnly) parts.push("scope=project_only");
  return `?${parts.join("&")}`;
}

export async function listSkills(opts?: { projectCwd?: string; projectOnly?: boolean }): Promise<SkillSummary[]> {
  const qs = buildScopedListQs(opts);
  const body = await getJson(
    `/skills${qs}`,
    (v): v is { skills: SkillSummary[] } =>
      typeof v === "object" &&
      v !== null &&
      Array.isArray((v as { skills?: unknown }).skills) &&
      (v as { skills: unknown[] }).skills.every(isSkillSummary),
  );
  return body.skills;
}

export async function getSkill(locId: string): Promise<SkillDetail> {
  return getJson(`/skills/${encodeURIComponent(locId)}`, isSkillDetail);
}

export async function getSkillTree(locId: string): Promise<SkillTreeResponse> {
  return getJson(`/skills/${encodeURIComponent(locId)}/tree`, isSkillTreeResponse);
}

/** Raw byte fetch for one file under a skill_dir. Returns the body
 * bytes plus the server-asserted Content-Type so the file viewer can
 * dispatch on it (markdown, image, monospace, hex-dump). 403 on
 * sandbox escape, 404 when missing, 400 when path is omitted or names
 * a directory. */
export async function getSkillFile(locId: string, path: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const u = url(`/skills/${encodeURIComponent(locId)}/file?path=${encodeURIComponent(path)}`);
  const res = await fetch(u);
  if (!res.ok) {
    throw new ApiError(`GET ${u} → ${res.status} ${res.statusText}`, res.status, u);
  }
  const buf = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
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
 * (lossless JSON round-trip). `nodeId` is fragua's projection of which
 * graph node emitted the turn. `iteration` is the loop-iteration counter
 * for the emitting node (0 for the first dispatch).
 *
 * `runId` is intentionally absent — the URL pins it for single-run
 * reads, so `ordinal` alone is a stable identity. */
export interface RunMessageRow {
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
}

export async function getRunMessages(id: string, sinceOrdinal?: number): Promise<RunMessageRow[]> {
  const params = new URLSearchParams();
  if (sinceOrdinal != null && sinceOrdinal > 0) params.set("sinceOrdinal", String(sinceOrdinal));
  const qs = params.toString();
  const path = qs ? `/runs/${encodeURIComponent(id)}/messages?${qs}` : `/runs/${encodeURIComponent(id)}/messages`;
  return getJson(path, (v): v is RunMessageRow[] => Array.isArray(v));
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
  model?: string;
  priority?: number;
}): Promise<{ jobId: string; runId: string }> {
  const body = {
    workflow: input.workflow,
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
 * doesn't re-upload workflow source. `cwd` lands on `run_state.cwd` and is
 * how the project filter on /projects/:id resolves the run later. */
/**
 * Web-side enqueue input. The web UI never computes or pins a workflow
 * sha — the server resolves the named workflow off disk (latest
 * contents) via the same listing it serves to the client. Required
 * fields: `cwd` (project root the run targets) and `workflowName`. The
 * upload-then-enqueue path with an explicit `workflowSha` is reserved
 * for the CLI and is not exposed here.
 */
export interface CreateRunInput {
  /** Local checkout the run targets (LOCATION). Always required — the
   *  server attaches the project IDENTITY from it. */
  cwd: string;
  /** Optional project IDENTITY when the caller already knows it (e.g. the
   *  project page). The server still derives identity from `cwd` when absent. */
  projectId?: string;
  workflowName: string;
  workflowScope?: "global" | "local" | "path" | "ephemeral";
  /** Typed input bindings for the workflow's `inputs:` block. Keys are
   *  input names; values are string-coerced values (booleans/numbers
   *  serialise as "true" / "42" etc.). Forwarded as `inputs` on POST /runs. */
  inputs?: Record<string, string>;
  priority?: number;
}

export async function createRun(args: CreateRunInput): Promise<{ runId: string }> {
  const body: Record<string, unknown> = {
    cwd: args.cwd,
    workflowName: args.workflowName,
  };
  if (args.projectId !== undefined) body["projectId"] = args.projectId;
  if (args.workflowScope !== undefined) body["workflowScope"] = args.workflowScope;
  if (args.inputs !== undefined) body["inputs"] = args.inputs;
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

export async function submitHitlChoice(runId: string, route: string, note?: string): Promise<{ seq: number }> {
  const body: { route: string; note?: string } = { route };
  if (note) body.note = note;
  return postJson(`/runs/${encodeURIComponent(runId)}/human`, body, isAcceptedSeq);
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

export async function acceptRun(id: string): Promise<{ seq: number }> {
  return postJson(`/runs/${encodeURIComponent(id)}/accept`, {}, isAcceptedSeq);
}

export async function discardRun(id: string): Promise<{ seq: number }> {
  return postJson(`/runs/${encodeURIComponent(id)}/discard`, {}, isAcceptedSeq);
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

/** Raise a node's `max_retries` cap on a `paused{reason:"max_retries"}`
 *  run. Stage 3 of recoverable-budget-pause.md. Sibling of
 *  {@link adjustBudget}; same Raise & Resume bundle pattern. */
export async function adjustMaxRetries(
  id: string,
  nodeId: string,
  newLimit: number,
  note?: string,
): Promise<{ seq: number }> {
  const body: { nodeId: string; newLimit: number; note?: string } = { nodeId, newLimit };
  if (note !== undefined) body.note = note;
  return postJson(`/runs/${encodeURIComponent(id)}/max_retries`, body, isAcceptedSeq);
}

/** Raise `max_goal_gate_retries` on a `paused{reason:"goal_gate"}` run. */
export async function adjustGoalGate(id: string, newLimit: number, note?: string): Promise<{ seq: number }> {
  const body: { newLimit: number; note?: string } = { newLimit };
  if (note !== undefined) body.note = note;
  return postJson(`/runs/${encodeURIComponent(id)}/goal_gate`, body, isAcceptedSeq);
}

/** Raise the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run. */
export async function adjustMaxLoops(id: string, newLimit: number, note?: string): Promise<{ seq: number }> {
  const body: { newLimit: number; note?: string } = { newLimit };
  if (note !== undefined) body.note = note;
  return postJson(`/runs/${encodeURIComponent(id)}/max_loops`, body, isAcceptedSeq);
}

// ── Schedules ────────────────────────────────────────────────────────
// Mirror of `Schedule` from @fragua/store/types.ts. Camel-case on the wire
// per the server's `schedule-routes.ts` payload (the store boundary
// performs row→domain translation). `recentRuns` is embedded by
// `GET /schedules` (last-10 health stripe — keeps the list a single round
// trip).

export type ScheduleOverlapPolicy = "skip" | "queue" | "concurrent";

export interface Schedule {
  id: string;
  workflowRef: string;
  cwd: string;
  intervalMs: number;
  intervalText: string;
  title: string | null;
  overlapPolicy: ScheduleOverlapPolicy;
  nextFireAt: number;
  lastFireAt: number | null;
  lastRunId: string | null;
  pausedAt: number | null;
  createdAt: number;
}

export interface ScheduleRunRow {
  runId: string;
  status: string;
  enqueuedAt: number;
}

export interface ScheduleWithStripe extends Schedule {
  recentRuns: ScheduleRunRow[];
}

export async function listSchedules(): Promise<ScheduleWithStripe[]> {
  return getJson("/schedules", (v): v is ScheduleWithStripe[] => Array.isArray(v) && v.every(isScheduleWithStripe));
}

export async function pauseSchedule(id: string): Promise<Schedule> {
  return postJson(`/schedules/${encodeURIComponent(id)}/pause`, undefined, isSchedule);
}

export async function resumeSchedule(id: string): Promise<Schedule> {
  return postJson(`/schedules/${encodeURIComponent(id)}/resume`, undefined, isSchedule);
}

export async function deleteSchedule(id: string): Promise<{ deleted: string }> {
  const u = url(`/schedules/${encodeURIComponent(id)}`);
  const res = await fetch(u, { method: "DELETE" });
  if (!res.ok) throw new ApiError(`DELETE ${u} → ${res.status} ${res.statusText}`, res.status, u);
  const body = (await res.json()) as { deleted?: unknown };
  if (typeof body.deleted !== "string") throw new Error(`DELETE ${u} → malformed response`);
  return { deleted: body.deleted };
}

// ── Analytics ────────────────────────────────────────────────────────

export type WorkflowScopeFilter = "global" | "local";

export interface AnalyticsRequest {
  fromMs: number;
  toMs: number;
  bucket: BucketKind;
  tzOffsetMinutes: number;
  compareFromMs?: number | null;
  compareToMs?: number | null;
  /** Optional project filter by IDENTITY (`run_state.project_id`). Folds
   *  clones/imports. The query-key includes this field so toggling the
   *  project selector re-fetches without a stale-cache flash. */
  projectId?: string;
  /** Optional project filter by LOCATION — exact `run_state.cwd` match. */
  cwd?: string;
  /** Optional workflow filter — predicate `(workflow_scope, workflow_name)`
   *  so all shas of one workflow identity aggregate together. Local
   *  workflows additionally need `cwd` to disambiguate same-named
   *  locals across projects; the WorkflowSelector enforces that
   *  pairing on the UI side. */
  workflowScope?: WorkflowScopeFilter;
  workflowName?: string;
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
  if (req.projectId) params.set("project_id", req.projectId);
  if (req.cwd) params.set("cwd", req.cwd);
  if (req.workflowScope && req.workflowName) {
    params.set("workflowScope", req.workflowScope);
    params.set("workflowName", req.workflowName);
  }
  return getJson(`/analytics?${params.toString()}`, isAnalyticsPayload);
}

export interface AnalyticsRunsRequest {
  fromMs: number;
  toMs: number;
  workflowSha?: string | undefined;
  haltCategory?: string | undefined;
  model?: string | undefined;
  /** Same shape + semantics as `AnalyticsRequest.projectId`; lets the
   *  drill-down drawer stay scoped to the project IDENTITY the user picked. */
  projectId?: string | undefined;
  /** Same shape + semantics as `AnalyticsRequest.cwd` (LOCATION). */
  cwd?: string | undefined;
  /** Same shape as `AnalyticsRequest.workflow{Scope,Name}` so the
   *  drawer inherits the workflow filter alongside cwd. */
  workflowScope?: WorkflowScopeFilter | undefined;
  workflowName?: string | undefined;
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
  if (req.projectId) params.set("project_id", req.projectId);
  if (req.cwd) params.set("cwd", req.cwd);
  if (req.workflowScope && req.workflowName) {
    params.set("workflowScope", req.workflowScope);
    params.set("workflowName", req.workflowName);
  }
  if (req.limit !== undefined) params.set("limit", String(req.limit));
  if (req.cursor) params.set("cursor", req.cursor);
  return getJson(`/analytics/runs?${params.toString()}`, isAnalyticsRunsPage);
}

/** One row of the workflow selector. `cwd` is null for `scope='global'`
 *  (those identities transcend projects). For `scope='local'` it pins
 *  the local workflow to one project root. */
export interface AnalyticsWorkflowEntry {
  scope: WorkflowScopeFilter;
  name: string;
  cwd: string | null;
  runCount: number;
  lastActivityMs: number;
}

export async function getAnalyticsWorkflows(opts: { cwd?: string | null } = {}): Promise<AnalyticsWorkflowEntry[]> {
  const params = new URLSearchParams();
  if (opts.cwd) params.set("cwd", opts.cwd);
  const url = params.toString().length > 0 ? `/analytics/workflows?${params.toString()}` : `/analytics/workflows`;
  const payload = await getJson(url, isAnalyticsWorkflowsPayload);
  return payload.workflows;
}

function isAnalyticsWorkflowsPayload(v: unknown): v is { workflows: AnalyticsWorkflowEntry[] } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o["workflows"]) && o["workflows"].every(isAnalyticsWorkflowEntry);
}

function isAnalyticsWorkflowEntry(v: unknown): v is AnalyticsWorkflowEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o["scope"] === "global" || o["scope"] === "local") &&
    typeof o["name"] === "string" &&
    (o["cwd"] === null || typeof o["cwd"] === "string") &&
    typeof o["runCount"] === "number" &&
    typeof o["lastActivityMs"] === "number"
  );
}

function isAnalyticsPayload(v: unknown): v is AnalyticsPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["window"] === "object" &&
    typeof o["totals"] === "object" &&
    (o["firstRunAt"] === null || typeof o["firstRunAt"] === "number") &&
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
  /** Human label — "stored api_key", "stored oauth", or null.
   * Never contains the key itself. */
  auth_source: string | null;
  /** `api_key` / `oauth` when a row exists in `provider_credentials`;
   * `null` when no credential is configured. */
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
  provider_config_error: string | null;
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

// `kind` is no longer wire-relevant after the credentials-in-the-store
// proposal landed — the server stores `key` verbatim. The literal-only
// shape is kept exported so older callers don't break; new code should
// just call `setProviderCredentials(name, key)` with a single string.
export type ProviderCredentialKind = "literal";

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

export async function setProviderCredentials(name: string, key: string): Promise<{ ok: boolean }> {
  return postJson(
    `/providers/${encodeURIComponent(name)}/credentials`,
    { key },
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
    projectId?: unknown;
    projectName?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.eventCount === "number" &&
    (o.projectId === undefined || typeof o.projectId === "string") &&
    (o.projectName === undefined || typeof o.projectName === "string") &&
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
    projectId?: unknown;
    projectName?: unknown;
    imported?: unknown;
  };
  return (
    typeof o.runId === "string" &&
    typeof o.startedAt === "string" &&
    typeof o.status === "string" &&
    typeof o.lastEventSeq === "number" &&
    (o.projectId === undefined || typeof o.projectId === "string") &&
    (o.projectName === undefined || typeof o.projectName === "string") &&
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
    (o.imported === undefined || typeof o.imported === "boolean") &&
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
  const o = v as {
    projectId?: unknown;
    name?: unknown;
    cwd?: unknown;
    cwdHint?: unknown;
    lastUpdatedAt?: unknown;
    runCount?: unknown;
  };
  return (
    typeof o.projectId === "string" &&
    typeof o.name === "string" &&
    (o.cwd === null || typeof o.cwd === "string") &&
    (o.cwdHint === null || o.cwdHint === undefined || typeof o.cwdHint === "string") &&
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
  if (typeof (v as { source?: unknown }).source !== "string") return false;
  // `inputs` is optional — older servers omit it; soft-validate when present.
  const inputs = (v as { inputs?: unknown }).inputs;
  if (inputs !== undefined && !Array.isArray(inputs)) return false;
  return true;
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
    locId?: unknown;
    name?: unknown;
    description?: unknown;
    location?: unknown;
    skill_dir?: unknown;
    sha256?: unknown;
    bytes?: unknown;
    scope?: unknown;
    source_dir?: unknown;
  };
  return (
    typeof o.locId === "string" &&
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    typeof o.location === "string" &&
    typeof o.skill_dir === "string" &&
    typeof o.sha256 === "string" &&
    typeof o.bytes === "number" &&
    (o.scope === "project" || o.scope === "user") &&
    typeof o.source_dir === "string"
  );
}

function isSkillDetail(v: unknown): v is SkillDetail {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { skill?: unknown; frontmatter?: unknown; body?: unknown };
  return (
    isSkillSummary(o.skill) && typeof o.frontmatter === "object" && o.frontmatter !== null && typeof o.body === "string"
  );
}

function isSkillTreeEntry(v: unknown): v is SkillTreeEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { path?: unknown; type?: unknown; size?: unknown };
  return typeof o.path === "string" && (o.type === "file" || o.type === "dir") && typeof o.size === "number";
}

function isSkillTreeResponse(v: unknown): v is SkillTreeResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { tree?: unknown; truncated?: unknown };
  return Array.isArray(o.tree) && o.tree.every(isSkillTreeEntry) && typeof o.truncated === "boolean";
}

function isSchedule(v: unknown): v is Schedule {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["workflowRef"] === "string" &&
    typeof o["cwd"] === "string" &&
    typeof o["intervalMs"] === "number" &&
    typeof o["intervalText"] === "string" &&
    (o["title"] === null || typeof o["title"] === "string") &&
    (o["overlapPolicy"] === "skip" || o["overlapPolicy"] === "queue" || o["overlapPolicy"] === "concurrent") &&
    typeof o["nextFireAt"] === "number" &&
    (o["lastFireAt"] === null || typeof o["lastFireAt"] === "number") &&
    (o["lastRunId"] === null || typeof o["lastRunId"] === "string") &&
    (o["pausedAt"] === null || typeof o["pausedAt"] === "number") &&
    typeof o["createdAt"] === "number"
  );
}

function isScheduleRunRow(v: unknown): v is ScheduleRunRow {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { runId?: unknown; status?: unknown; enqueuedAt?: unknown };
  return typeof o.runId === "string" && typeof o.status === "string" && typeof o.enqueuedAt === "number";
}

function isScheduleWithStripe(v: unknown): v is ScheduleWithStripe {
  if (!isSchedule(v)) return false;
  const recent = (v as { recentRuns?: unknown }).recentRuns;
  return Array.isArray(recent) && recent.every(isScheduleRunRow);
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
