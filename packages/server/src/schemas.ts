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
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  updatedAt: Type.String(),
});
export type StatsPayload = Static<typeof StatsPayload>;
