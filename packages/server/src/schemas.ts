// TypeBox schemas for the REST surface. Exported so `@swarm/web` can reuse
// the exact same contracts — keeps client and server types in lockstep.
//
// Kept in a single file because the schemas are small and cross-referenced.
// If any outgrows ~30 lines, split per-file and re-export from here.

import { type Static, Type } from "@sinclair/typebox";

/** Summary row returned by `GET /pipelines`. Derived from the JSONL tail. */
export const PipelineSummary = Type.Object({
  runId: Type.String(),
  /** Workflow source identifier (graph label or sha). Optional: pre-start runs have none. */
  workflow: Type.Optional(Type.String()),
  /** ISO-8601 of the first event, or the directory's ctime as a fallback. */
  startedAt: Type.String(),
  /** Derived status: "running" | "success" | "fail" | "unknown". */
  status: Type.Union([Type.Literal("running"), Type.Literal("success"), Type.Literal("fail"), Type.Literal("unknown")]),
  /** Count of events seen — useful for quick activity glance in the UI. */
  eventCount: Type.Integer({ minimum: 0 }),
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
  startedAt: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("success"), Type.Literal("fail"), Type.Literal("unknown")]),
  /** Monotonic sequence of the last event we've replayed. */
  lastEventSeq: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(NodeState),
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
