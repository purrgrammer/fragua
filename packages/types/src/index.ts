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

export type { AgentMessage, AgentToolCall, AgentToolResult } from "@mariozechner/pi-agent-core";
export type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
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
  type HaltReason,
  type InboxStatus,
  type IntentEvent,
  type IntentType,
  isTerminal,
  type MessageRole,
  type PauseReason,
  type QuarantineReason,
  type RawEvent,
  type RunEnqueuedPayload,
  type RunStatus,
  type SnapshotCapturedData,
  type SnapshotStat,
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

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    system: SystemPromptMessage;
    tool_node: ToolNodeMessage;
  }
}
