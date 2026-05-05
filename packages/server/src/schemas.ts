// TypeBox schemas for the REST surface. Exported so `@swarm/web` can reuse
// the same contracts.

import { type Static, Type } from "@sinclair/typebox";

export const HitlOption = Type.Object({
  key: Type.String(),
  label: Type.String(),
  to: Type.String(),
});
export type HitlOption = Static<typeof HitlOption>;

/** Coarse UI status — one badge per category. The Inbox / fine-grained
 * filters use `runStatus` (the raw store status) instead. */
const UiStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("success"),
  Type.Literal("fail"),
  Type.Literal("canceled"),
  Type.Literal("unknown"),
]);

/** Raw run lifecycle status, mirrored from `@swarm/types` `RunStatus`.
 * Carried alongside the coarse `status` so the web can distinguish
 * `paused_hitl` vs `paused` (Inbox) and `halted` vs `quarantined`
 * (Inbox vs Feed) without re-reading the event log. */
const RawRunStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("paused_hitl"),
  Type.Literal("paused_provider_retry"),
  Type.Literal("paused_retry"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("halted"),
  Type.Literal("quarantined"),
]);

/** Summary row returned by `GET /runs`. */
export const RunSummary = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: UiStatus,
  runStatus: RawRunStatus,
  eventCount: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
  /** Project root the run was enqueued from. Mirrors `run_state.cwd` —
   * the only project identifier in the harness-by-default model. Absent
   * for ephemeral runs (CI primitives, tests). */
  cwd: Type.Optional(Type.String()),
});
export type RunSummary = Static<typeof RunSummary>;

export const NodeState = Type.Object({
  nodeId: Type.String(),
  /** Loop iteration this entry describes (0 for the first dispatch, 1 for
   * the first re-entry across a backward edge or goal-gate retarget, …). A
   * non-looping run carries only `iteration: 0` entries. */
  iteration: Type.Integer({ minimum: 0 }),
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

/** `(from, to)` pair for an edge the executor actually traversed. Projected
 * from the run's `edge.selected` event stream. Lets the UI fade edges that
 * were never taken so the executed path pops visually. Multiple entries for
 * the same `(from, to)` are emitted when a back-edge or goal-gate retarget
 * re-traverses across iterations; `iteration` distinguishes them. */
export const SelectedEdge = Type.Object({
  from: Type.String(),
  to: Type.String(),
  iteration: Type.Integer({ minimum: 0 }),
});
export type SelectedEdge = Static<typeof SelectedEdge>;

export const RunDetail = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: UiStatus,
  runStatus: RawRunStatus,
  lastEventSeq: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(NodeState),
  selectedEdges: Type.Array(SelectedEdge),
  workflowSource: Type.Optional(Type.String()),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
  hitlNodeId: Type.Optional(Type.String()),
  hitlLabel: Type.Optional(Type.String()),
  hitlOptions: Type.Optional(Type.Array(HitlOption)),
  /** Project root the run was enqueued from. Mirrors `run_state.cwd`.
   * Absent for ephemeral runs (CI primitives, tests). */
  cwd: Type.Optional(Type.String()),
  /** Absolute path to the still-mounted worktree under
   * `<cwd>/.swarm/worktrees/<runId>`. Absent once the worktree has
   * been disposed (run terminal + provisioner cleanup) or for runs
   * that never had one (LocalEnvironmentProvisioner). */
  worktreePath: Type.Optional(Type.String()),
});
export type RunDetail = Static<typeof RunDetail>;

export const ErrorBody = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ErrorBody = Static<typeof ErrorBody>;

/**
 * Aggregate dashboard payload returned by `GET /metrics/global`. Backed by
 * the store's generated columns (`run_state.total_cost_usd` /
 * `billed_tokens`) plus a SUM over `metrics.totalInputTokens +
 * metrics.totalOutputTokens` for `fresh_tokens`. UI renders a 30-day
 * ticker without parsing any metrics JSON.
 *
 * `billed_tokens` = input + output + cacheRead + cacheWrite (invoice).
 * `fresh_tokens`  = input + output (work done — what `budget_tokens`
 * fences against).
 *
 * Per-model breakdown uses `json_each` over `run_state.metrics.models` —
 * executed server-side so only aggregated rows cross the wire.
 */
export const ModelBreakdownRow = Type.Object({
  model_name: Type.String(),
  tokens: Type.Integer({ minimum: 0 }),
  cost_usd: Type.Number({ minimum: 0 }),
});
export type ModelBreakdownRow = Static<typeof ModelBreakdownRow>;

/**
 * One row in `GET /projects`. A "project" is just a distinct
 * `run_state.cwd` — no separate registration table. `cwd` is the wire
 * identity (full absolute path); `name` is `basename(cwd)`, surfaced
 * server-side so the web doesn't reimplement path parsing. Two
 * checkouts of the same repo at different paths are distinct projects.
 */
export const ProjectSummary = Type.Object({
  cwd: Type.String(),
  name: Type.String(),
  lastUpdatedAt: Type.Integer({ minimum: 0 }),
  runCount: Type.Integer({ minimum: 0 }),
});
export type ProjectSummary = Static<typeof ProjectSummary>;

export const GlobalMetricsPayload = Type.Object({
  total_runs: Type.Integer({ minimum: 0 }),
  total_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  fresh_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  billed_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  successful: Type.Integer({ minimum: 0 }),
  halted: Type.Integer({ minimum: 0 }),
  running: Type.Integer({ minimum: 0 }),
  queued: Type.Integer({ minimum: 0 }),
  paused: Type.Integer({ minimum: 0 }),
  quarantined: Type.Integer({ minimum: 0 }),
  breakdownByModel: Type.Array(ModelBreakdownRow),
});
export type GlobalMetricsPayload = Static<typeof GlobalMetricsPayload>;
