// TypeBox schemas for the REST surface. Exported so `@fragua/web` can reuse
// the same contracts.
//
// The run-read view schemas (`RunSummary`, `NodeState`, `SelectedEdge`,
// `RunDetail`) live in the shared read plane (`@fragua/core/read-plane`);
// re-exported here so existing `import { RunSummary } from "../schemas.ts"`
// consumers keep working. The schemas below are HTTP/analytics-only.

import { type Static, Type } from "@sinclair/typebox";

export { NodeState, RunDetail, RunSummary, SelectedEdge } from "@fragua/core/read-plane";

export const ErrorBody = Type.Object({
  error: Type.String(),
  code: Type.Optional(Type.String()),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ErrorBody = Static<typeof ErrorBody>;

/**
 * Aggregate dashboard payload returned by `GET /metrics/global`. Backed
 * entirely by `run_state` generated columns (`total_cost_usd`,
 * `billed_tokens`); the UI renders a 30-day ticker without parsing
 * any metrics JSON.
 *
 * `billed_tokens` = input + output + cacheRead + cacheWrite — the
 * headline figure that matches the run's invoiced cost and pi-ai's
 * `usage.totalTokens`. Budget enforcement runs against fresh tokens
 * only and is owned by the daemon executor; that signal is not
 * surfaced here.
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
 * One row in `GET /projects`. A "project" is a distinct `run_state.project_id`
 * (IDENTITY) — the stable UUID committed in `<cwd>/.fragua/config.yaml`, so
 * clones, machines, and imports of the same project fold into one row. There is
 * no separate registration table. `projectId` is the wire identity; `name` is
 * the display label; `cwd` / `cwdHint` carry the most-recent local checkout as a
 * LOCATION hint for the file/tree views — either is `null` for an imported-only
 * project with no local checkout.
 */
export const ProjectSummary = Type.Object({
  projectId: Type.String(),
  name: Type.String(),
  cwd: Type.Union([Type.String(), Type.Null()]),
  cwdHint: Type.Union([Type.String(), Type.Null()]),
  lastUpdatedAt: Type.Integer({ minimum: 0 }),
  runCount: Type.Integer({ minimum: 0 }),
});
export type ProjectSummary = Static<typeof ProjectSummary>;

export const GlobalMetricsPayload = Type.Object({
  total_runs: Type.Integer({ minimum: 0 }),
  total_usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
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
