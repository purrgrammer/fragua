// TypeBox schemas for the REST surface. Exported so `@swarm/web` can reuse
// the exact same contracts — keeps client and server types in lockstep.
//
// Kept in a single file because the schemas are small and cross-referenced.
// If any outgrows ~30 lines, split per-file and re-export from here.

import { type Static, Type } from "@sinclair/typebox";

/** Summary row returned by `GET /pipelines`. Derived from the JSONL tail. */
export const PipelineSummary = Type.Object({
  runId: Type.String(),
  /**
   * Workflow source identifier. Usually the basename of the `.dot` file
   * ("hello.dot"), but older runs or pre-start captures may carry a raw
   * SHA. UI layers should prefer `workflowName` for display and fall back
   * to this only when no name is available.
   */
  workflow: Type.Optional(Type.String()),
  /**
   * Human-readable workflow identifier, derived server-side:
   *   1. `data.workflow_label` on `pipeline.started` (if present)
   *   2. basename-without-extension of `data.workflow` when it looks like
   *      a filename (contains `.` or `/`)
   *   3. `data.graph_id` (the DOT `digraph foo { … }` identifier)
   *   4. undefined → UI renders "(unknown)"
   * The raw `workflow` stays as-is so the SHA remains available for
   * debuggability (e.g. via a hover tooltip).
   */
  workflowName: Type.Optional(Type.String()),
  /** ISO-8601 of the first event, or the directory's ctime as a fallback. */
  startedAt: Type.String(),
  /** Derived status: "running" | "success" | "fail" | "unknown". */
  status: Type.Union([Type.Literal("running"), Type.Literal("success"), Type.Literal("fail"), Type.Literal("unknown")]),
  /** Count of events seen — useful for quick activity glance in the UI. */
  eventCount: Type.Integer({ minimum: 0 }),
  // ── Derived metrics (task P5.06) ─────────────────────────────────────
  // All three are aggregated by replaying `cost.recorded` events via the
  // shared `@swarm/events` accumulator. Zero is the documented default
  // when no cost was reported (either the run had no LLM calls, or the
  // LLM adapter didn't emit `cost.recorded` — both are valid states).
  /** Sum of `data.cost_usd` across all `cost.recorded` events. */
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  /** Sum of `data.input_tokens`. Integer so Intl.NumberFormat is happy. */
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  /** Sum of `data.output_tokens`. */
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  /**
   * Sum of `data.cache_read_tokens` — cached prompt tokens reused from
   * prior calls (Anthropic prompt caching et al). Kept separate from
   * `inputTokens` because providers typically bill cache hits at a
   * fraction of fresh input. Zero when no cost.recorded events carry
   * the field (older runs or providers that don't report it).
   */
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  /** Sum of `data.cache_write_tokens` — first-time cache priming. */
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  /**
   * Run wall-clock duration in milliseconds, computed as
   * `lastEvent.timestamp − firstEvent.timestamp`. Optional because a run
   * with fewer than two events (or unparseable timestamps) has no
   * meaningful duration; UI treats `undefined` as "—". For live/running
   * runs the value reflects progress through the latest observed event,
   * which advances as new events arrive.
   */
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * Auto-generated pipeline title (Wave 2b). Sourced from the first
   * `pipeline.title_generated` event; `undefined` on runs that predate
   * Wave 2b, were launched with `--no-auto-title`, or whose summariser
   * call failed. UI layers should fall back to `input` (when captured
   * on `pipeline.started.data.input`) or the workflow name.
   */
  title: Type.Optional(Type.String()),
  /**
   * Raw `$ARGUMENTS` captured on `pipeline.started.data.input`. Exposed
   * so the UI has a sensible title fallback when `title` is absent, and
   * so the title-backfill script has a deterministic source.
   */
  input: Type.Optional(Type.String()),
});
export type PipelineSummary = Static<typeof PipelineSummary>;

/** Per-node state snapshot built by replaying events. */
export const NodeState = Type.Object({
  nodeId: Type.String(),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
    Type.Literal("retrying"),
  ]),
  lastEventSeq: Type.Integer({ minimum: 0 }),
});
export type NodeState = Static<typeof NodeState>;

/** Full detail returned by `GET /pipelines/:runId`. */
export const PipelineDetail = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("success"), Type.Literal("fail"), Type.Literal("unknown")]),
  /** Monotonic sequence of the last event we've replayed. */
  lastEventSeq: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(NodeState),
  /**
   * Raw DOT source, copied through from `pipeline.started.data.workflow_source`
   * when present. The web UI parses this with `@swarm/core`'s `parseDotSource`
   * to recover the full topology (nodes + edges + labels + attrs) for the
   * graph canvas. Absent when the run predates source capture, the start
   * event was partial, or source was redacted — UI layers show an empty
   * state in that case rather than guessing edges from the event stream.
   */
  workflowSource: Type.Optional(Type.String()),
  // Mirror of the summary metrics — see PipelineSummary for semantics.
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Auto-generated title — see PipelineSummary.title. */
  title: Type.Optional(Type.String()),
  /** Raw `$ARGUMENTS` — see PipelineSummary.input. */
  input: Type.Optional(Type.String()),
});
export type PipelineDetail = Static<typeof PipelineDetail>;

/** One outstanding question posed by a `wait.human` node. */
export const InterviewQuestion = Type.Object({
  questionId: Type.String(),
  nodeId: Type.String(),
  text: Type.String(),
  type: Type.Union([
    Type.Literal("YES_NO"),
    Type.Literal("MULTIPLE_CHOICE"),
    Type.Literal("FREEFORM"),
    Type.Literal("CONFIRMATION"),
  ]),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        label: Type.String(),
      }),
    ),
  ),
  stage: Type.String(),
  /** ISO-8601 timestamp of the originating `wait.human` event. */
  askedAt: Type.String(),
});
export type InterviewQuestion = Static<typeof InterviewQuestion>;

/** Body of `POST /pipelines/:runId/interview/:questionId`. */
export const InterviewAnswer = Type.Object({
  /** Usually one of "YES" | "NO" | an option key | free text. */
  value: Type.String({ minLength: 1 }),
  /** Optional free-form commentary. */
  text: Type.Optional(Type.String()),
});

// ───── Control channel ──────────────────────────────────────────────────
// Bodies for `POST /pipelines/:runId/{steer,pause,resume,cancel}`.
// Each endpoint returns `{ id: <uuid> }` on success (202) — the id
// matches the `control.requested.data.id` the run's event stream will
// carry, so the caller can correlate without re-reading the control
// file.

/** Body of `POST /pipelines/:runId/steer`. */
export const ControlSteerBody = Type.Object({
  /** User message to inject at the agent's next turn boundary. */
  message: Type.String({ minLength: 1 }),
});
export type ControlSteerBody = Static<typeof ControlSteerBody>;

/** Body of `POST /pipelines/:runId/pause`. `reason` surfaces on the
 * `control.requested.data.payload.reason` event for audit. */
export const ControlPauseBody = Type.Object({
  reason: Type.Optional(Type.String()),
});
export type ControlPauseBody = Static<typeof ControlPauseBody>;

/** Body of `POST /pipelines/:runId/cancel`. Mirrors `ControlPauseBody`;
 * kept distinct so schema docs stay per-endpoint readable. */
export const ControlCancelBody = Type.Object({
  reason: Type.Optional(Type.String()),
});
export type ControlCancelBody = Static<typeof ControlCancelBody>;

/** Response body for any accepted control request. */
export const ControlAccepted = Type.Object({
  /** The uuid assigned to this control request. Echoed on the
   * `control.requested` / `control.applied` events for correlation. */
  id: Type.String(),
});
export type ControlAccepted = Static<typeof ControlAccepted>;

// ───── Jobs (daemon queue) ──────────────────────────────────────────────
// Body + response shapes for `POST /jobs`, `GET /jobs`, `GET /jobs/:id`,
// `DELETE /jobs/:id`. The daemon's SQLite queue is the only producer
// of these rows; a server running in foreground mode (no daemon) has
// no queue and returns 503 on the same URLs.

/** Body of `POST /jobs`. Enqueues one workflow run. */
export const JobEnqueueBody = Type.Object({
  /** Path to the `.dot` workflow (relative to the daemon's repo root). */
  workflow: Type.String({ minLength: 1 }),
  /** Free-form user input passed through as `$ARGUMENTS`. Mirrors
   * `swarm run --input` one-for-one. */
  input: Type.Optional(Type.String()),
  /** Optional model override; maps to `--model` on the worker. */
  model: Type.Optional(Type.String()),
  /** Higher runs first; default 0. */
  priority: Type.Optional(Type.Integer()),
  /** Client-supplied run id. Default auto-generated
   * (`${Date.now()}-${random6}`) to match `swarm run`. */
  runId: Type.Optional(Type.String({ minLength: 1 })),
  /** Client-supplied job id (idempotency key). Default uuid. */
  id: Type.Optional(Type.String({ minLength: 1 })),
});
export type JobEnqueueBody = Static<typeof JobEnqueueBody>;

/** Terminal + active statuses for a job row. Kept as a TypeBox literal
 * union so OpenAPI generators + client validation pick it up. */
export const JobStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("success"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);
export type JobStatusSchema = Static<typeof JobStatusSchema>;

/** Wire shape of a single job. The internal `JobRow` type carries
 * `inputJson` (serialized); on the wire we expose `input` so clients
 * don't have to know about the storage representation. */
export const JobRowSchema = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  workflow: Type.String(),
  input: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  status: JobStatusSchema,
  priority: Type.Integer(),
  enqueuedAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
  childPid: Type.Optional(Type.Integer()),
  error: Type.Optional(Type.String()),
});
export type JobRowSchema = Static<typeof JobRowSchema>;

/** Response body for `POST /jobs`. `runId` is echoed so the caller can
 * deep-link into `/pipelines/:runId/events` without a second round-trip. */
export const JobAccepted = Type.Object({
  jobId: Type.String(),
  runId: Type.String(),
});
export type JobAccepted = Static<typeof JobAccepted>;
export type InterviewAnswer = Static<typeof InterviewAnswer>;

/** Uniform error envelope. All non-2xx responses conform to this. */
export const ErrorBody = Type.Object({
  error: Type.String(),
  /** Machine-readable code; defaults to the HTTP status text. */
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ErrorBody = Static<typeof ErrorBody>;

/**
 * One agent step — the fully-assembled context for a single
 * `backend.run()` / `llm.start` call. Wave 5 endpoint
 * `GET /pipelines/:runId/steps` returns `StepSnapshot[]`, ordered by
 * timestamp. The shape mirrors `packages/server/src/lib/steps.ts`
 * `StepSnapshot` exactly — keep them in lockstep. All optional fields
 * absent when not captured on older runs.
 */
export const StepSnapshotContextFile = Type.Object(
  {
    path: Type.String(),
    sha256: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    status: Type.String(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const StepSnapshotMessage = Type.Object(
  {
    role: Type.String(),
    content: Type.Optional(Type.Unknown()),
    timestamp: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export const StepSnapshotSettings = Type.Object(
  {
    temperature: Type.Optional(Type.Number()),
    max_tokens: Type.Optional(Type.Number()),
    top_p: Type.Optional(Type.Number()),
    reasoning_effort: Type.Optional(Type.String()),
    stop: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

export const StepSnapshotBudget = Type.Object(
  {
    cumulative_cost_usd: Type.Number({ minimum: 0 }),
    cumulative_tokens: Type.Number({ minimum: 0 }),
    max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
    run_max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: true },
);

export const StepSnapshotCost = Type.Object(
  {
    input_tokens: Type.Number({ minimum: 0 }),
    output_tokens: Type.Number({ minimum: 0 }),
    total_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cache_read_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cache_write_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cost_usd: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);

export const StepSnapshotSkill = Type.Object(
  {
    name: Type.String(),
    location: Type.String(),
    sha256: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
    source_dir: Type.String(),
  },
  { additionalProperties: true },
);

export const StepSnapshot = Type.Object({
  stepIdx: Type.Integer({ minimum: 0 }),
  nodeId: Type.String(),
  iteration: Type.Optional(
    Type.Object({ n: Type.Integer({ minimum: 1 }), max: Type.Integer({ minimum: 1 }) }, { additionalProperties: true }),
  ),
  startedAt: Type.String(),
  endedAt: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  provider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  fidelity: Type.Optional(Type.String()),
  prompt: Type.String(),
  systemPrompt: Type.String(),
  allowedTools: Type.Array(Type.String()),
  deniedTools: Type.Array(Type.String()),
  settings: Type.Optional(StepSnapshotSettings),
  messages: Type.Array(StepSnapshotMessage),
  contextFiles: Type.Array(StepSnapshotContextFile),
  skills: Type.Array(StepSnapshotSkill),
  budget: Type.Optional(StepSnapshotBudget),
  cost: Type.Optional(StepSnapshotCost),
  finalText: Type.String(),
  stopReason: Type.Optional(Type.String()),
});
export type StepSnapshot = Static<typeof StepSnapshot>;

/**
 * Aggregate returned by `GET /stats`. One number per tile on the Home
 * dashboard — derived server-side over every run under `runsDir` so the
 * tiles stay accurate even after we add pagination to `GET /pipelines`.
 *
 * Conventions:
 *   - `successRate` is `succeeded / (succeeded + failed)`; 0 when no
 *     terminal runs exist (preferred over NaN so the wire shape stays
 *     uniformly numeric).
 *   - `avgDurationMs` is omitted (not zero) when no terminal runs exist
 *     — same "absent vs zero" discipline as `PipelineSummary.durationMs`.
 *   - `updatedAt` is the server's wall-clock at response time. The
 *     client uses it to decide whether to refresh; we don't TTL-cache
 *     yet so it's always "now", but exposing the field keeps the door
 *     open for caching without a wire-shape change.
 */
export const StatsPayload = Type.Object({
  totalRuns: Type.Integer({ minimum: 0 }),
  running: Type.Integer({ minimum: 0 }),
  succeeded: Type.Integer({ minimum: 0 }),
  failed: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  totalCostUsd: Type.Number({ minimum: 0 }),
  totalInputTokens: Type.Integer({ minimum: 0 }),
  totalOutputTokens: Type.Integer({ minimum: 0 }),
  /**
   * Aggregate cache-hit tokens across every run. Useful for tracking
   * prompt-cache efficiency: a healthy archive should see this number
   * growing roughly in line with `totalInputTokens` once workloads
   * stabilise. Zero on archives that predate cache-token capture.
   */
  totalCacheReadTokens: Type.Integer({ minimum: 0 }),
  totalCacheWriteTokens: Type.Integer({ minimum: 0 }),
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  updatedAt: Type.String(),
});
export type StatsPayload = Static<typeof StatsPayload>;

/** One row of `GET /skills`. Catalog metadata only — bodies are lazy. */
export const SkillSummarySchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  version: Type.Optional(Type.String()),
  allowed_tools: Type.Optional(Type.Array(Type.String())),
  location: Type.String(),
  skill_dir: Type.String(),
  sha256: Type.String(),
  bytes: Type.Integer({ minimum: 0 }),
  scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
  source_dir: Type.String(),
  disabled_reason: Type.Optional(Type.String()),
});
export type SkillSummarySchema = Static<typeof SkillSummarySchema>;

/** Detail payload for `GET /skills/:name`. `usage` is present when the
 * server was configured with a `runReader` so the route can fold
 * `local:load_skill` tool-call events into a recent-runs list. */
export const SkillDetailSchema = Type.Intersect([
  SkillSummarySchema,
  Type.Object({
    body: Type.String(),
    usage: Type.Optional(
      Type.Object({
        runs: Type.Array(Type.String()),
        count: Type.Integer({ minimum: 0 }),
      }),
    ),
  }),
]);
export type SkillDetailSchema = Static<typeof SkillDetailSchema>;
