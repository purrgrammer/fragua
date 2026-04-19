// TypeBox schemas for the REST surface. Exported so `@swarm/web` can reuse
// the same contracts.

import { type Static, Type } from "@sinclair/typebox";

/** Summary row returned by `GET /pipelines`. */
export const PipelineSummary = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("success"),
    Type.Literal("fail"),
    Type.Literal("canceled"),
    Type.Literal("unknown"),
  ]),
  eventCount: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
});
export type PipelineSummary = Static<typeof PipelineSummary>;

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

export const PipelineDetail = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("success"),
    Type.Literal("fail"),
    Type.Literal("canceled"),
    Type.Literal("unknown"),
  ]),
  lastEventSeq: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(NodeState),
  workflowSource: Type.Optional(Type.String()),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
});
export type PipelineDetail = Static<typeof PipelineDetail>;

export const ErrorBody = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ErrorBody = Static<typeof ErrorBody>;

/**
 * Aggregate dashboard payload returned by `GET /metrics/global`. Backed by
 * the store's generated columns (`run_state.total_cost_usd` /
 * `total_tokens`) so the UI can render a 30-day ticker without parsing any
 * metrics JSON.
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

export const GlobalMetricsPayload = Type.Object({
  total_runs: Type.Integer({ minimum: 0 }),
  total_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  total_tokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  successful: Type.Integer({ minimum: 0 }),
  halted: Type.Integer({ minimum: 0 }),
  running: Type.Integer({ minimum: 0 }),
  queued: Type.Integer({ minimum: 0 }),
  paused: Type.Integer({ minimum: 0 }),
  quarantined: Type.Integer({ minimum: 0 }),
  breakdownByModel: Type.Array(ModelBreakdownRow),
});
export type GlobalMetricsPayload = Static<typeof GlobalMetricsPayload>;
