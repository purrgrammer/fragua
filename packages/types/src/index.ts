// @fragua/types — pi-agent-core / pi-ai types used throughout the
// codebase, plus fragua-specific declaration merges. Every package
// that handles messages imports from here instead of directly from
// pi-agent-core so the custom-role merges below apply consistently
// across the TypeScript compile graph.
//
// Why a separate package: TypeScript declaration merging only applies
// to files that are actually part of a compile unit. A merge living
// in @fragua/store won't be visible to @fragua/web unless web's tsc
// pulls store's source into its graph — which it doesn't, since web
// only imports @fragua/core. Putting the merge here and having every
// consumer import from @fragua/types guarantees the merge activates.

export type { AgentMessage, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
export type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
export {
  ALL_DAEMON_EVENT_TYPES,
  ALL_EVENT_TYPES,
  type AnyEvent,
  type AnyEventType,
  AUTO_WAKE_PAUSE_REASONS,
  type ChangeStat,
  type DaemonEvent,
  type DaemonEventEnvelope,
  type DaemonEventType,
  type EventEnvelope,
  type EventType,
  type EventWriter,
  type FactEvent,
  type FactType,
  FEED_EVENT_KINDS,
  type FeedEvent,
  HALT_REASONS,
  type HaltReason,
  type InboxStatus,
  type IntentEvent,
  type IntentType,
  isSettled,
  isTerminal,
  type MessageRole,
  mapStatus,
  NODE_LIFECYCLE_FACT_TYPES,
  PAUSE_REASONS,
  type PauseReason,
  type QuarantineReason,
  type RawEvent,
  RUN_STATE_FACT_TYPES,
  RUN_STATUSES,
  type RunEnqueuedPayload,
  type RunStatus,
  SETTLED_STATUS_TERMINAL_FACT,
  SETTLED_STATUSES,
  type SettledStatus,
  type SnapshotCapturedData,
  type SnapshotStat,
  STATUS_TO_UI,
  TERMINAL_FACT_TYPES,
  TERMINAL_RUN_FACT_TYPES,
  type UiStatus,
  VALID_WRITERS,
} from "./events.ts";
export type { Skill, SkillCatalogRecord, SkillScope, SkillsConfig } from "./skills.ts";

/** Fragua-specific custom message type: the assembled system prompt
 * for a single LLM call. Persisted in the `messages` table so UIs
 * and debuggers can reconstruct exactly what the model saw, without
 * hitting the 4KB cap on `llm.start`'s event payload. Filtered back
 * out before feeding priorMessages to pi-ai — pi-ai carries the
 * system prompt separately via `Context.systemPrompt`. */
export interface SystemPromptMessage {
  role: "system";
  content: string;
  timestamp: number;
}

/** Fragua-specific custom message type: a graph-level `tool` node
 * (tool node) execution. Captures the shell command, the
 * cwd it ran in, the exit code, and a tail-truncated slice of
 * stdout/stderr — enough for the UI to render a terminal card from
 * the `messages` table alone, without round-tripping to artifacts.
 * Full output stays in the artifacts (`<nodeId>:stdout` / `:stderr`);
 * `outputArtifactKey` is the key the UI can fetch when the inline
 * tail is truncated. Never feeds back into an LLM context — pi-ai
 * doesn't know this role exists, and the daemon filters it out
 * before assembling priorMessages, just like `system`. */
export interface ToolNodeMessage {
  role: "tool_node";
  /** Final substituted shell command. */
  command: string;
  /** Absolute path the command ran in. Sourced from
   * `ExecutionEnvironment.cwd()` when available, else the daemon's
   * `process.cwd()` (the bare-LocalEnv fallback). */
  cwd: string;
  exitCode: number;
  durationMs: number;
  /** Tail of stdout, capped at ~50KB. Truncation is indicated by
   * `stdoutTruncated`; the full bytes live in the artifact named in
   * `outputArtifactKey`. */
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  /** Artifact key for the canonical `output` artifact (full stdout).
   * `${nodeId}:stdout` and `${nodeId}:stderr` carry the same data
   * keyed to the producing node — kept here as the canonical pointer
   * so the UI doesn't have to re-derive the convention. */
  outputArtifactKey?: string;
  timestamp: number;
}

/** One threshold of a `decide.outcome`, with the noul it compared. */
export interface JudgeRuleVerdict {
  question: string;
  value: number;
  min?: number;
  max?: number;
  holds: boolean;
}

/** Row appended by a `type: judge` graph step — the questions asked and the
 * typed answers a System One model returned. Like `tool_node`, never feeds
 * back into an LLM context; the daemon filters it out of priorMessages. */
export interface JudgeNodeMessage {
  role: "judge_node";
  provider: string;
  /** Resolved model id from the response (`jev-1.13.0`). */
  model: string;
  /** Head of the serialised state, capped; the full state is never stored. */
  statePreview: string;
  stateBytes: number;
  /** question id → `{ type, instructions }` as sent (criteria omitted). */
  questions: Record<string, { type: "choice" | "score" | "noul"; instructions: unknown }>;
  /** question id → answer as returned by the API. */
  answers: Record<string, unknown>;
  /** What `decide:` made of it, when present — with the bound it was held to
   * and the value it compared, so a card can show the margin. */
  decision?:
    | { kind: "route"; route: string; belowThreshold: boolean; confidence: number; minConfidence?: number }
    | { kind: "outcome"; status: "success" | "fail"; rules: JudgeRuleVerdict[] };
  /** Set on a `for-each` judge: how many items were judged, in how many
   * requests, which indices a `keep:` kept, the `keep` bounds, and a short
   * label per item (its first string field). `answers` is keyed `<q>__<i>`. */
  forEach?: {
    count: number;
    chunks: number;
    kept?: number[];
    rules?: Array<{ question: string; min?: number; max?: number }>;
    labels?: string[];
  };
  durationMs: number;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    system: SystemPromptMessage;
    tool_node: ToolNodeMessage;
    judge_node: JudgeNodeMessage;
  }
}

/** Per-event payload cap (invariants I2 / I10). A byte cap, not a code-unit
 * cap — guards must measure UTF-8 bytes (`utf8ByteLength`), because
 * `String#length` counts UTF-16 code units and undercounts CJK / emoji by up
 * to ~3×. Owned here so both the store's `validatePayload` and core's genesis
 * pre-check (`@fragua/core`, which can't import from `@fragua/store`) share one
 * source of truth. */
export const MAX_EVENT_PAYLOAD_BYTES = 4096;

/** UTF-8 byte length of a string, zero-allocation. `Buffer.byteLength` is a
 * Node/Bun built-in that computes the encoded size without materialising a
 * `Uint8Array` — the hot write path runs this per event. */
export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
