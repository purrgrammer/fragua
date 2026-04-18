// TypeBox runtime schemas for events. The TypeScript `Event` / `LlmStartData`
// / `NodeStartedData` interfaces in `./events.ts` stay the compile-time
// source of truth; these schemas exist for runtime validation of JSONL read
// from disk (replay, fixture loading, server boundaries).
//
// Policy: the envelope is strict enough to catch real drift (missing / wrong
// type on required fields), but the `data` bag stays `Unknown` so a change
// to any payload shape doesn't break replay of older runs. Per-event-type
// payload schemas are exported individually — consumers opt into the
// stricter check per event type they care about.

import { type Static, Type } from "@sinclair/typebox";

/** Envelope fields common to every event. Keep these additive. Required
 * fields here are the ones a run cannot function without — drop any of
 * them and we can't attribute the event to a run at all. */
export const EventEnvelopeSchema = Type.Object(
  {
    run_id: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    timestamp: Type.String({ minLength: 1 }),
    workflow_sha: Type.String(),
    session_id: Type.Optional(Type.String()),
    node_id: Type.Optional(Type.String()),
    /** Absent on pre-versioned JSONL — consumers treat `undefined` as `1`. */
    schema_version: Type.Optional(Type.Number({ minimum: 1 })),
    data: Type.Unknown(),
  },
  { additionalProperties: true },
);
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

/** Per-file capture record (mirrors `ContextFileCapture` in `events.ts`). */
export const ContextFileCaptureSchema = Type.Object(
  {
    path: Type.String(),
    sha256: Type.String(),
    bytes: Type.Number({ minimum: 0 }),
    truncated: Type.Boolean(),
    status: Type.Union([Type.Literal("ok"), Type.Literal("missing")]),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/** Per-skill catalog capture record (mirrors `SkillCatalogCapture`). */
export const SkillCatalogCaptureSchema = Type.Object(
  {
    name: Type.String(),
    location: Type.String(),
    sha256: Type.String(),
    bytes: Type.Number({ minimum: 0 }),
    scope: Type.Union([Type.Literal("project"), Type.Literal("user")]),
    source_dir: Type.String(),
  },
  { additionalProperties: true },
);

export const LlmSettingsSchema = Type.Object(
  {
    temperature: Type.Optional(Type.Number()),
    max_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    top_p: Type.Optional(Type.Number()),
    reasoning_effort: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    stop: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

export const MessageSnapshotSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult")]),
    content: Type.Optional(Type.Unknown()),
    timestamp: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export const BudgetSnapshotSchema = Type.Object(
  {
    cumulative_cost_usd: Type.Number({ minimum: 0 }),
    cumulative_tokens: Type.Number({ minimum: 0 }),
    max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
    run_max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: true },
);

/** Payload schema for `llm.start`. Every field is optional because we don't
 * want a missing `allowed_tools` on an older run to fail validation — the
 * goal is to catch shape drift, not enforce perfect capture. */
export const LlmStartDataSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    prompt: Type.Optional(Type.String()),
    system_prompt: Type.Optional(Type.String()),
    thread_id: Type.Optional(Type.String()),
    allowed_tools: Type.Optional(Type.Array(Type.String())),
    denied_tools: Type.Optional(Type.Array(Type.String())),
    iteration: Type.Optional(
      Type.Object(
        {
          n: Type.Number({ minimum: 1 }),
          max: Type.Number({ minimum: 1 }),
        },
        { additionalProperties: true },
      ),
    ),
    messages: Type.Optional(Type.Array(MessageSnapshotSchema)),
    settings: Type.Optional(LlmSettingsSchema),
    context_files: Type.Optional(Type.Array(ContextFileCaptureSchema)),
    budget: Type.Optional(BudgetSnapshotSchema),
    skills: Type.Optional(Type.Array(SkillCatalogCaptureSchema)),
  },
  { additionalProperties: true },
);
export type LlmStartDataStatic = Static<typeof LlmStartDataSchema>;

export const NodeStartedDataSchema = Type.Object(
  {
    node_type: Type.Optional(Type.String()),
    prompt_template: Type.Optional(Type.String()),
    context_keys: Type.Optional(Type.Array(Type.String())),
    node_outputs_in_scope: Type.Optional(Type.Array(Type.String())),
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    thread_id: Type.Optional(Type.String()),
    fidelity: Type.Optional(Type.String()),
    allowed_tools: Type.Optional(Type.Array(Type.String())),
    denied_tools: Type.Optional(Type.Array(Type.String())),
    context_files: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);

const SummaryPurposeSchema = Type.Union([Type.Literal("title"), Type.Literal("fidelity")]);

const IterationSchema = Type.Object(
  { n: Type.Number({ minimum: 1 }), max: Type.Number({ minimum: 1 }) },
  { additionalProperties: true },
);

export const SummaryStartedDataSchema = Type.Object(
  {
    purpose: SummaryPurposeSchema,
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    caller_node_id: Type.Optional(Type.String()),
    iteration: Type.Optional(IterationSchema),
    fidelity: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const SummaryTextDeltaDataSchema = Type.Object(
  {
    purpose: SummaryPurposeSchema,
    delta: Type.String(),
    content_index: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);

export const SummaryCompletedDataSchema = Type.Object(
  {
    purpose: SummaryPurposeSchema,
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    caller_node_id: Type.Optional(Type.String()),
    iteration: Type.Optional(IterationSchema),
    fidelity: Type.Optional(Type.String()),
    input_tokens: Type.Number({ minimum: 0 }),
    output_tokens: Type.Number({ minimum: 0 }),
    cost_usd: Type.Number({ minimum: 0 }),
    duration_ms: Type.Number({ minimum: 0 }),
    output_text: Type.String(),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const PipelineTitleGeneratedDataSchema = Type.Object(
  {
    title: Type.String(),
    summary_node_id: Type.String(),
  },
  { additionalProperties: true },
);

export const BudgetBreachDataSchema = Type.Object(
  {
    scope: Type.Union([Type.Literal("node"), Type.Literal("run")]),
    metric: Type.Union([Type.Literal("cost"), Type.Literal("tokens")]),
    limit: Type.Number({ minimum: 0 }),
    actual: Type.Number({ minimum: 0 }),
    ratio: Type.Optional(Type.Number({ minimum: 0 })),
    caller_node_id: Type.Optional(Type.String()),
    run_max_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
    run_max_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    reason: Type.String(),
  },
  { additionalProperties: true },
);

export const CostRecordedDataSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    stop_reason: Type.Optional(Type.String()),
    input_tokens: Type.Number({ minimum: 0 }),
    output_tokens: Type.Number({ minimum: 0 }),
    cache_read_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cache_write_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    total_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    cost_usd: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);

/** Opt-in payload schemas keyed by event type. Consumers pick the ones they
 * care about — everything else stays permissive. */
export const PAYLOAD_SCHEMAS = {
  "llm.start": LlmStartDataSchema,
  "node.started": NodeStartedDataSchema,
  "cost.recorded": CostRecordedDataSchema,
  "summary.started": SummaryStartedDataSchema,
  "summary.text_delta": SummaryTextDeltaDataSchema,
  "summary.completed": SummaryCompletedDataSchema,
  "pipeline.title_generated": PipelineTitleGeneratedDataSchema,
  "budget.warn": BudgetBreachDataSchema,
  "budget.stop": BudgetBreachDataSchema,
} as const;
